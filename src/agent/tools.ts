/**
 * Tool definitions (zod -> strict JSON schema) and the executor that runs
 * them inside the sandbox. Every failure comes back as a tool_result with
 * is_error: true; nothing here throws into the loop.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { isTestFile, type ProjectInfo } from "../sandbox/detect.js";
import { formatSummary, newFailures, parseTestOutput, type TestSummary } from "../sandbox/testParser.js";
import { shellQuote, toWorkspaceRelative, type ExecResult, type Sandbox } from "../sandbox/types.js";
import type { TrajectoryLogger } from "../trajectory/logger.js";
import { denyReason, truncateOutput } from "./limits.js";

export const toolSchemas = {
  bash: z.object({
    command: z.string().describe("Shell command to run with bash -lc in /workspace."),
    timeout_s: z.number().int().optional().describe("Timeout in seconds. Default 120, maximum 600."),
  }),
  read_file: z.object({
    path: z.string().describe("File path relative to /workspace."),
    start_line: z.number().int().optional().describe("1-based first line to return."),
    end_line: z.number().int().optional().describe("1-based last line to return (inclusive)."),
  }),
  edit_file: z.object({
    path: z.string().describe("File path relative to /workspace."),
    old_text: z.string().describe("Exact text to replace. Must occur exactly once in the file."),
    new_text: z.string().describe("Replacement text."),
  }),
  write_file: z.object({
    path: z.string().describe("File path relative to /workspace. Parent directories are created."),
    content: z.string().describe("Full file content."),
  }),
  search: z.object({
    pattern: z.string().describe("Regular expression (ripgrep syntax)."),
    glob: z.string().optional().describe("Limit to files matching this glob, e.g. 'src/**/*.ts'."),
  }),
  run_tests: z.object({
    command: z.string().optional().describe("Test command. Defaults to the detected test command for the whole suite."),
  }),
  submit: z.object({
    summary: z.string().describe("What changed and why, in two or three sentences, for the pull request."),
    root_cause: z.string().describe("Root cause of the bug in one or two sentences."),
    test_file: z.string().describe("Path of the test you added that reproduces the bug."),
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;

const descriptions: Record<ToolName, string> = {
  bash: "Run a shell command inside the sandbox (no network). Returns stdout, stderr and the exit code. Output is truncated to 10,000 characters.",
  read_file: "Read a text file from the repository, optionally a line range.",
  edit_file: "Replace one exact occurrence of old_text with new_text in a file. Fails if old_text is missing or appears more than once; include enough surrounding lines to make it unique.",
  write_file: "Create or overwrite a file with the given content. Use it for new test files; prefer edit_file for existing source files.",
  search: "Search file contents with ripgrep. Returns file:line:text matches.",
  run_tests: "Run the test suite (or a specific test command) and get a parsed pass/fail summary plus the tail of the output.",
  submit: "Finish the run. Call it only after the repro test passes and the full suite has no new failures. The harness re-runs the suite and rejects the submission if anything regressed.",
};

/** zod -> JSON schema that satisfies strict tool use (no numeric bounds, additionalProperties false). */
export function toInputSchema(schema: z.ZodObject): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json["$schema"];
  const props = json["properties"] as Record<string, Record<string, unknown>>;
  for (const prop of Object.values(props)) {
    delete prop["minimum"];
    delete prop["maximum"];
  }
  json["additionalProperties"] = false;
  return json as unknown as Anthropic.Tool.InputSchema;
}

export function toolDefinitions(): Anthropic.Tool[] {
  return (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
    name,
    description: descriptions[name],
    strict: true,
    input_schema: toInputSchema(toolSchemas[name]),
  }));
}

export type Phase = "reproduce" | "fix" | "done";

export interface TestRun {
  command: string;
  summary: TestSummary;
  output: string;
  exitCode: number;
}

export interface Submission {
  summary: string;
  root_cause: string;
  test_file: string;
}

export interface AgentState {
  phase: Phase;
  /** Files created or modified through write_file / edit_file. */
  writtenFiles: Set<string>;
  /** First test run that showed the bug (the "before" output). */
  repro: TestRun | null;
  lastTestRun: TestRun | null;
  /** Full-suite run done by the harness when submit was accepted (the "after" output). */
  finalTestRun: TestRun | null;
  lintOutput: string | null;
  submission: Submission | null;
  commandsTried: string[];
  /** Harness notices appended to the next user message (phase changes, warnings). */
  notices: string[];
}

export function initialState(): AgentState {
  return {
    phase: "reproduce",
    writtenFiles: new Set(),
    repro: null,
    lastTestRun: null,
    finalTestRun: null,
    lintOutput: null,
    submission: null,
    commandsTried: [],
    notices: [],
  };
}

export interface Baseline {
  tests: TestSummary;
  testOutput: string;
  lint: { ok: boolean; output: string } | null;
  /** Test files that existed before the agent started. */
  testFiles: Set<string>;
}

export interface ToolContext {
  sandbox: Sandbox;
  project: ProjectInfo;
  baseline: Baseline;
  state: AgentState;
  trajectory: TrajectoryLogger;
  log: (msg: string) => void;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** True when submit was accepted and the run should end. */
  done?: boolean;
}

function formatExec(res: ExecResult): string {
  const parts = [`exit code: ${res.exitCode}${res.timedOut ? " (timed out)" : ""}`];
  if (res.stdout.trim()) parts.push(`--- stdout ---\n${res.stdout.trimEnd()}`);
  if (res.stderr.trim()) parts.push(`--- stderr ---\n${res.stderr.trimEnd()}`);
  if (!res.stdout.trim() && !res.stderr.trim()) parts.push("(no output)");
  return truncateOutput(parts.join("\n"));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export async function runTestCommand(ctx: ToolContext, command: string, timeoutMs = 600_000): Promise<TestRun> {
  const res = await ctx.sandbox.exec(command, { timeoutMs });
  const output = `${res.stdout}\n${res.stderr}`;
  const summary = parseTestOutput(output, res.exitCode, ctx.project.framework);
  return { command, summary, output, exitCode: res.exitCode };
}

function maybeEnterFixPhase(ctx: ToolContext, run: TestRun): void {
  const { state } = ctx;
  if (state.phase !== "reproduce") return;
  if (run.summary.failed === 0) return;
  const wroteTest = [...state.writtenFiles].some(isTestFile);
  if (!wroteTest) return;
  state.repro = run;
  state.phase = "fix";
  const notice =
    `[harness] Phase A complete: the bug is reproduced (${run.summary.failed} failing). ` +
    `Phase B starts now: make the smallest source change that fixes it, then run the full suite and call submit.`;
  state.notices.push(notice);
  ctx.trajectory.log({ type: "phase", from: "reproduce", to: "fix", reason: `test run failed: ${run.command}` });
  ctx.log("phase A complete: bug reproduced");
}

const looksLikeTestCommand = (cmd: string) => /\b(vitest|jest|mocha|pytest|go test|npm test|pnpm test|yarn test|node --test)\b/.test(cmd);

async function bash(ctx: ToolContext, input: z.infer<typeof toolSchemas.bash>): Promise<ToolOutcome> {
  const reason = denyReason(input.command);
  if (reason) return { content: `command denied by the sandbox policy: ${reason}`, isError: true };
  ctx.state.commandsTried.push(input.command);
  const res = await ctx.sandbox.exec(input.command, { timeoutMs: (input.timeout_s ?? 120) * 1000 });
  if (looksLikeTestCommand(input.command)) {
    const output = `${res.stdout}\n${res.stderr}`;
    const summary = parseTestOutput(output, res.exitCode, ctx.project.framework);
    const run = { command: input.command, summary, output, exitCode: res.exitCode };
    if (summary.parsed) {
      ctx.state.lastTestRun = run;
      maybeEnterFixPhase(ctx, run);
    }
  }
  return { content: formatExec(res), isError: false };
}

async function readFile(ctx: ToolContext, input: z.infer<typeof toolSchemas.read_file>): Promise<ToolOutcome> {
  const rel = toWorkspaceRelative(input.path);
  const text = await ctx.sandbox.readFile(rel);
  const lines = text.split("\n");
  const start = Math.max(1, input.start_line ?? 1);
  const end = Math.min(lines.length, input.end_line ?? lines.length);
  if (start > end) return { content: `invalid range: file has ${lines.length} lines`, isError: true };
  const slice = lines.slice(start - 1, end).join("\n");
  const header = `${rel} (lines ${start}-${end} of ${lines.length})\n`;
  return { content: header + truncateOutput(slice), isError: false };
}

async function editFile(ctx: ToolContext, input: z.infer<typeof toolSchemas.edit_file>): Promise<ToolOutcome> {
  const rel = toWorkspaceRelative(input.path);
  if (!(await ctx.sandbox.exists(rel))) return { content: `file not found: ${rel}`, isError: true };
  const text = await ctx.sandbox.readFile(rel);
  const n = countOccurrences(text, input.old_text);
  if (n === 0) return { content: `old_text not found in ${rel}. Read the file and copy the text exactly (whitespace matters).`, isError: true };
  if (n > 1) return { content: `old_text occurs ${n} times in ${rel}; include more surrounding lines so it is unique.`, isError: true };
  const idx = text.indexOf(input.old_text);
  const updated = text.slice(0, idx) + input.new_text + text.slice(idx + input.old_text.length);
  await ctx.sandbox.writeFile(rel, updated);
  ctx.state.writtenFiles.add(rel);
  const line = lineAt(text, idx);
  const removed = input.old_text.split("\n").map((l) => `- ${l}`);
  const added = input.new_text.split("\n").map((l) => `+ ${l}`);
  return { content: `edited ${rel} at line ${line}:\n${[...removed, ...added].join("\n")}`, isError: false };
}

async function writeFile(ctx: ToolContext, input: z.infer<typeof toolSchemas.write_file>): Promise<ToolOutcome> {
  const rel = toWorkspaceRelative(input.path);
  if (rel === "") return { content: "path is required", isError: true };
  if (ctx.baseline.testFiles.has(rel) && !ctx.state.writtenFiles.has(rel)) {
    return {
      content: `${rel} is an existing test file. Overwriting existing tests is not allowed; use edit_file to add a test case, or create a new test file.`,
      isError: true,
    };
  }
  const existed = await ctx.sandbox.exists(rel);
  await ctx.sandbox.writeFile(rel, input.content);
  ctx.state.writtenFiles.add(rel);
  return { content: `${existed ? "overwrote" : "created"} ${rel} (${Buffer.byteLength(input.content, "utf8")} bytes)`, isError: false };
}

async function search(ctx: ToolContext, input: z.infer<typeof toolSchemas.search>): Promise<ToolOutcome> {
  const globArg = input.glob ? `-g ${shellQuote(input.glob)} ` : "";
  const cmd =
    `rg -n --no-heading --color never --max-columns 300 -g '!node_modules' -g '!.git' -g '!dist' -g '!.venv' ` +
    `${globArg}-e ${shellQuote(input.pattern)} . 2>&1 || grep -rn --exclude-dir=node_modules --exclude-dir=.git -E -e ${shellQuote(input.pattern)} .`;
  const res = await ctx.sandbox.exec(cmd, { timeoutMs: 60_000 });
  const out = res.stdout.trim();
  if (!out) return { content: `no matches for ${JSON.stringify(input.pattern)}${input.glob ? ` in ${input.glob}` : ""}`, isError: false };
  const lines = out.split("\n");
  const shown = lines.slice(0, 200).map((l) => l.replace(/^\.\//, ""));
  const note = lines.length > 200 ? `\n[... ${lines.length - 200} more matches; narrow the pattern or glob]` : "";
  return { content: truncateOutput(shown.join("\n") + note), isError: false };
}

async function runTests(ctx: ToolContext, input: z.infer<typeof toolSchemas.run_tests>): Promise<ToolOutcome> {
  const command = input.command ?? ctx.project.testCommand;
  if (!command) return { content: "no test command detected for this project; pass one explicitly or run a repro script with bash", isError: true };
  const reason = denyReason(command);
  if (reason) return { content: `command denied by the sandbox policy: ${reason}`, isError: true };
  ctx.state.commandsTried.push(command);
  const run = await runTestCommand(ctx, command);
  ctx.state.lastTestRun = run;
  maybeEnterFixPhase(ctx, run);
  const tail = truncateOutput(run.output.trim(), 6_000);
  return {
    content: `command: ${command}\nexit code: ${run.exitCode}\nsummary: ${formatSummary(run.summary)}\n--- output ---\n${tail}`,
    isError: false,
  };
}

/**
 * The harness, not the model, decides whether the work is done:
 * reproduced first, repro test now passes, no new failures vs. baseline,
 * no deletions in pre-existing tests, lint still clean, a real source change.
 */
export async function verifySubmission(ctx: ToolContext, input: Submission): Promise<ToolOutcome> {
  const { state, baseline, sandbox, project } = ctx;
  const fail = (stage: string, msg: string): ToolOutcome => {
    ctx.trajectory.log({ type: "verification", stage, ok: false, detail: msg });
    return { content: `submission rejected (${stage}): ${msg}`, isError: true };
  };
  const pass = (stage: string, detail: unknown) => ctx.trajectory.log({ type: "verification", stage, ok: true, detail });

  if (state.phase === "reproduce") {
    return fail("reproduce", "the bug has not been reproduced yet. Write a failing test, run it with run_tests and see it fail before fixing.");
  }
  const testRel = toWorkspaceRelative(input.test_file);
  if (!(await sandbox.exists(testRel))) return fail("test_file", `${testRel} does not exist`);
  if (!state.writtenFiles.has(testRel)) return fail("test_file", `${testRel} was not written in this run; point test_file at the test you added`);

  // Source change present?
  const status = await sandbox.exec("git status --porcelain --untracked-files=all", { timeoutMs: 60_000 });
  const changed = status.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3).trim().replace(/^"|"$/g, "") }));
  const sourceChanges = changed.filter((c) => !isTestFile(c.path));
  if (sourceChanges.length === 0) return fail("diff", "no source files changed; only tests were added. Fix the bug before submitting.");
  const deletedTests = changed.filter((c) => c.code.includes("D") && isTestFile(c.path));
  if (deletedTests.length > 0) return fail("tests", `test files were deleted: ${deletedTests.map((c) => c.path).join(", ")}. Restore them.`);

  // Pre-existing tests may gain lines but never lose them.
  const numstat = await sandbox.exec("git diff --numstat HEAD", { timeoutMs: 60_000 });
  for (const line of numstat.stdout.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const deleted = m[2] === "-" ? 0 : Number(m[2]);
    const file = m[3]!.trim();
    if (deleted > 0 && baseline.testFiles.has(file)) {
      return fail("tests", `${file} is an existing test file and ${deleted} line(s) were removed from it. Never weaken or delete existing tests; revert that change.`);
    }
  }
  pass("tests-untouched", { changed: changed.map((c) => c.path) });

  // Full suite vs baseline.
  if (project.testCommand) {
    const run = await runTestCommand(ctx, project.testCommand);
    state.lastTestRun = run;
    const regressions = newFailures(baseline.tests, run.summary);
    const testBase = testRel.slice(testRel.lastIndexOf("/") + 1);
    const reproStillFailing = run.summary.failedTests.some((t) => t.includes(testRel) || t.includes(testBase));
    if (reproStillFailing || regressions.length > 0 || run.summary.failed > baseline.tests.failed) {
      const detail = [
        `summary: ${formatSummary(run.summary)}`,
        regressions.length ? `new failures vs baseline: ${regressions.join(", ")}` : "",
        reproStillFailing ? `your repro test ${testRel} still fails` : "",
        "--- output tail ---",
        truncateOutput(run.output.trim(), 4_000),
      ]
        .filter(Boolean)
        .join("\n");
      return fail("suite", detail);
    }
    state.finalTestRun = run;
    pass("suite", { summary: run.summary });
  } else {
    // No framework: at least make sure the repro script exits 0 now.
    state.finalTestRun = state.lastTestRun;
  }

  // Lint, only when the repo has one and it was clean before.
  if (project.lintCommand) {
    const lint = await sandbox.exec(project.lintCommand, { timeoutMs: 300_000 });
    const out = truncateOutput(`${lint.stdout}\n${lint.stderr}`.trim(), 4_000);
    state.lintOutput = `exit code ${lint.exitCode}\n${out}`;
    if (lint.exitCode !== 0 && (baseline.lint?.ok ?? true)) {
      return fail("lint", `${project.lintCommand} fails after your change but passed before:\n${out}`);
    }
    pass("lint", { exitCode: lint.exitCode, baselineOk: baseline.lint?.ok ?? null });
  }

  state.submission = input;
  state.phase = "done";
  ctx.trajectory.log({ type: "phase", from: "fix", to: "done", reason: "submission verified" });
  return { content: "submission accepted: repro test passes, no new failures, lint clean. The host will now open the pull request.", isError: false, done: true };
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!(name in toolSchemas)) return { content: `unknown tool: ${name}`, isError: true };
  const schema = toolSchemas[name as ToolName];
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    return { content: `invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, isError: true };
  }
  try {
    switch (name as ToolName) {
      case "bash":
        return await bash(ctx, parsed.data as z.infer<typeof toolSchemas.bash>);
      case "read_file":
        return await readFile(ctx, parsed.data as z.infer<typeof toolSchemas.read_file>);
      case "edit_file":
        return await editFile(ctx, parsed.data as z.infer<typeof toolSchemas.edit_file>);
      case "write_file":
        return await writeFile(ctx, parsed.data as z.infer<typeof toolSchemas.write_file>);
      case "search":
        return await search(ctx, parsed.data as z.infer<typeof toolSchemas.search>);
      case "run_tests":
        return await runTests(ctx, parsed.data as z.infer<typeof toolSchemas.run_tests>);
      case "submit":
        return await verifySubmission(ctx, parsed.data as Submission);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "SandboxExpiredError") throw err;
    return { content: `${name} failed: ${message}`, isError: true };
  }
}
