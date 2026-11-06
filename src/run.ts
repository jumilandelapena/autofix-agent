/**
 * The pipeline: issue -> sandbox -> baseline -> agent loop -> verify -> PR.
 * Used by the CLI, the eval runner and the end-to-end tests.
 */
import fs from "node:fs";
import path from "node:path";
import { runAgentLoop, type Outcome, type TurnInfo } from "./agent/loop.js";
import { DEFAULT_RUN_LIMITS, type RunLimits } from "./agent/limits.js";
import { emptyTotals, type UsageTotals } from "./agent/pricing.js";
import { buildIssueMessage, buildSystemPrompt } from "./agent/prompt.js";
import { createProvider, type LlmProvider } from "./agent/provider.js";
import { initialState, runTestCommand, toolDefinitions, type Baseline, type ToolContext } from "./agent/tools.js";
import { LocalGitHub, OctokitGitHub } from "./github/client.js";
import { parseIssueRef, type IssueRef } from "./github/issueRef.js";
import { AI_LABEL, buildPrBody, conventionalCommitMessage, prTitle } from "./github/prBody.js";
import { applyPatch, branchNameFor, cloneRepository, commitAndPush, currentBranch, exportPatch, prepareLocalSource, stagedDiff } from "./github/publish.js";
import type { GitHubApi, IssueData } from "./github/types.js";
import { createSandbox, type SandboxKind } from "./sandbox/index.js";
import { detectProject, isTestFile } from "./sandbox/detect.js";
import { formatSummary, type TestSummary } from "./sandbox/testParser.js";
import type { Sandbox } from "./sandbox/types.js";
import { TrajectoryLogger } from "./trajectory/logger.js";

export interface FixOptions {
  issue: string;
  dryRun?: boolean | undefined;
  maxSteps?: number | undefined;
  budgetUsd?: number | undefined;
  baseImage?: string | undefined;
  sandbox?: SandboxKind | undefined;
  /** Clone from this local directory instead of GitHub (offline runs, evals, CI). */
  repoPath?: string | undefined;
  /** Read the issue from this issues.json instead of GitHub. */
  issuesFile?: string | undefined;
  /** Mock provider fixture; defaults to evals/fixtures/mock/issue-<N>.json. */
  fixture?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  runsDir?: string | undefined;
  github?: GitHubApi | undefined;
  llm?: LlmProvider | undefined;
  log?: ((line: string) => void) | undefined;
  onTurn?: ((info: TurnInfo) => void) | undefined;
}

export interface FixResult {
  runId: string;
  runDir: string;
  issue: IssueRef;
  title: string;
  outcome: Outcome;
  detail: string;
  reproduced: boolean;
  fixed: boolean;
  suiteGreen: boolean;
  steps: number;
  totals: UsageTotals;
  durationMs: number;
  diff: string;
  changedFiles: string[];
  branch: string | null;
  pr: { url: string; number: number } | null;
  pushed: boolean;
  prFile: string | null;
  baseline: TestSummary | null;
  after: TestSummary | null;
  model: string;
  provider: string;
}

function timestampId(n: number): string {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-issue-${n}`;
}

async function fileTree(sb: Sandbox): Promise<string> {
  const res = await sb.exec(
    "find . -maxdepth 2 -not -path './.git*' -not -path './node_modules*' -not -path '*/node_modules/*' -not -path './.venv*' | sort | head -80",
    { timeoutMs: 30_000 },
  );
  return res.stdout.trim() || "(empty)";
}

async function listTestFiles(sb: Sandbox): Promise<Set<string>> {
  const res = await sb.exec("git ls-files", { timeoutMs: 60_000 });
  return new Set(res.stdout.split("\n").map((l) => l.trim()).filter((f) => f && isTestFile(f)));
}

function notReproducedComment(issue: IssueData, detail: string, commands: string[], runId: string): string {
  const tried = commands.length ? commands.slice(-15).map((c) => `- \`${c.replace(/`/g, "'")}\``).join("\n") : "- (no commands run)";
  return `autofix-agent could not reproduce this issue, so no pull request was opened.

**Reason:** ${detail}

**Commands tried (last ${Math.min(commands.length, 15)}):**
${tried}

A human may need to add reproduction steps, expected vs. actual output, or the exact environment. Run id: \`${runId}\`.`;
}

export async function runFix(opts: FixOptions): Promise<FixResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const ref = parseIssueRef(opts.issue);
  const runsDir = path.resolve(opts.runsDir ?? "runs");
  const runId = timestampId(ref.number);
  const runDir = path.join(runsDir, runId);
  const dryRun = opts.dryRun ?? false;
  const sandboxKind: SandboxKind = opts.sandbox ?? (process.env["AUTOFIX_SANDBOX"] as SandboxKind | undefined) ?? "docker";
  const limits: RunLimits = {
    ...DEFAULT_RUN_LIMITS,
    maxSteps: opts.maxSteps ?? DEFAULT_RUN_LIMITS.maxSteps,
    budgetUsd: opts.budgetUsd ?? DEFAULT_RUN_LIMITS.budgetUsd,
  };

  const github: GitHubApi =
    opts.github ??
    (opts.issuesFile
      ? new LocalGitHub(path.resolve(opts.issuesFile), path.resolve(opts.repoPath ?? path.dirname(opts.issuesFile)), runDir)
      : (OctokitGitHub.fromEnv() ??
        (() => {
          throw new Error("GITHUB_TOKEN is not set. Export it, or pass --issues-file and --repo-path for an offline run.");
        })()));

  const providerKind = (opts.provider ?? process.env["LLM_PROVIDER"] ?? "anthropic").toLowerCase();
  const fixture = opts.fixture ?? (providerKind === "mock" ? path.resolve("evals/fixtures/mock", `issue-${ref.number}.json`) : undefined);
  const llm = opts.llm ?? createProvider({ provider: providerKind, model: opts.model, fixturePath: fixture });

  const trajectory = new TrajectoryLogger(runDir);
  log(`run ${runId}`);
  log(`fetching issue ${ref.url}`);
  const issue = await github.fetchIssue(ref);
  trajectory.log({
    type: "run_start",
    issue: { url: issue.htmlUrl, title: issue.title, number: ref.number },
    options: { dryRun, maxSteps: limits.maxSteps, budgetUsd: limits.budgetUsd, sandbox: sandboxKind, provider: llm.name, model: llm.model, image: opts.baseImage ?? null },
  });
  log(`#${ref.number} ${issue.title}`);

  const result: FixResult = {
    runId,
    runDir,
    issue: ref,
    title: issue.title,
    outcome: "error",
    detail: "",
    reproduced: false,
    fixed: false,
    suiteGreen: false,
    steps: 0,
    totals: emptyTotals(),
    durationMs: 0,
    diff: "",
    changedFiles: [],
    branch: null,
    pr: null,
    pushed: false,
    prFile: null,
    baseline: null,
    after: null,
    model: llm.model,
    provider: llm.name,
  };

  let sandbox: Sandbox | null = null;
  try {
    // 1. Host clone (simple-git). The sandbox gets a copy; the host keeps this one for the PR.
    const repoDir = path.join(runDir, "repo");
    const source = opts.repoPath ? await prepareLocalSource(opts.repoPath, runDir) : issue.cloneUrl;
    log(`cloning ${source}`);
    await cloneRepository({ source, dest: repoDir, branch: opts.repoPath ? undefined : issue.defaultBranch });
    const baseBranch = await currentBranch(repoDir);

    // 2. Sandbox with the repo inside, dependencies installed, baseline recorded, then offline.
    sandbox = await createSandbox({
      kind: sandboxKind,
      repoDir,
      runId,
      image: opts.baseImage ?? process.env["AUTOFIX_BASE_IMAGE"],
      seedNodeModulesFrom: opts.repoPath,
      log: (m) => {
        trajectory.log({ type: "sandbox", event: m });
        log(`sandbox: ${m}`);
      },
    });
    const project = await detectProject(sandbox, { cleanInstall: sandboxKind === "docker" });
    log(`project: ${project.facts[0]}; tests: ${project.testCommand ?? "none"}`);
    if (project.installCommand) {
      log(`installing dependencies: ${project.installCommand}`);
      const install = await sandbox.exec(project.installCommand, { timeoutMs: 600_000 });
      trajectory.log({ type: "sandbox", event: "install", detail: { command: project.installCommand, exitCode: install.exitCode, stderr: install.stderr.slice(-2000) } });
      if (install.exitCode !== 0) throw new Error(`dependency install failed (exit ${install.exitCode}): ${install.stderr.slice(-1500)}`);
      // Installers may rewrite tracked files (package-lock.json, go.sum, uv.lock).
      // Commit those side effects inside the sandbox so every later diff against
      // HEAD contains only what the agent changed.
      const settle = await sandbox.exec(
        'git config user.name autofix-agent && git config user.email autofix-agent@users.noreply.github.com && git add -u && (git diff --cached --quiet || git commit -q -m "chore(autofix): dependency install side effects, not part of the fix")',
        { timeoutMs: 120_000 },
      );
      if (settle.exitCode !== 0) trajectory.warn(`could not record install side effects: ${settle.stderr.slice(-500)}`);
    }

    const ctx: ToolContext = {
      sandbox,
      project,
      baseline: { tests: { framework: project.framework, passed: 0, failed: 0, skipped: 0, total: 0, failedTests: [], parsed: false }, testOutput: "", lint: null, testFiles: new Set() },
      state: initialState(),
      trajectory,
      log,
    };
    if (project.testCommand) {
      log(`baseline: ${project.testCommand}`);
      const run = await runTestCommand(ctx, project.testCommand);
      ctx.baseline.tests = run.summary;
      ctx.baseline.testOutput = run.output;
      log(`baseline: ${formatSummary(run.summary).split("\n")[0]}`);
    }
    if (project.lintCommand) {
      const lint = await sandbox.exec(project.lintCommand, { timeoutMs: 300_000 });
      ctx.baseline.lint = { ok: lint.exitCode === 0, output: `${lint.stdout}\n${lint.stderr}`.trim() };
      log(`baseline lint: ${ctx.baseline.lint.ok ? "clean" : "failing (ignored)"}`);
    }
    ctx.baseline.testFiles = await listTestFiles(sandbox);
    const baseline: Baseline = ctx.baseline;
    result.baseline = baseline.tests;
    trajectory.log({ type: "baseline", project, tests: baseline.tests, lint: baseline.lint ? { ok: baseline.lint.ok } : null });
    await sandbox.disconnectNetwork();
    trajectory.log({ type: "sandbox", event: "network disconnected" });

    // 3-5. The agent loop; the harness enforces phases and verifies the submission.
    const system = buildSystemPrompt({ project, baseline, limits, defaultBranch: baseBranch, fileTree: await fileTree(sandbox) });
    const agent = await runAgentLoop({
      provider: llm,
      system,
      tools: toolDefinitions(),
      firstUserMessage: buildIssueMessage(issue),
      ctx,
      limits,
      onTurn: opts.onTurn,
    });
    result.outcome = agent.outcome;
    result.detail = agent.detail;
    result.steps = agent.turns;
    result.totals = agent.totals;
    result.reproduced = ctx.state.repro !== null;
    const { state } = ctx;

    // Always keep the patch for inspection, whatever the outcome.
    let patch = "";
    let files: string[] = [];
    try {
      ({ patch, files } = await exportPatch(sandbox));
    } catch (err) {
      trajectory.warn(`could not export patch: ${(err as Error).message}`);
    }
    if (patch.trim()) {
      fs.writeFileSync(path.join(runDir, "fix.patch"), patch);
      // The Docker workspace is a copy, so the patch is applied to the host
      // clone. The local sandbox works directly in the host clone, where
      // exportPatch already staged the change.
      if (sandbox.kind === "docker") await applyPatch(repoDir, patch);
      result.diff = await stagedDiff(repoDir);
      result.changedFiles = files;
    }

    if (agent.outcome === "submitted" && state.submission && state.repro && state.finalTestRun) {
      result.fixed = true;
      result.after = state.finalTestRun.summary;
      result.suiteGreen = state.finalTestRun.summary.failed <= baseline.tests.failed;
      const branch = branchNameFor(ref, issue.title);
      result.branch = branch;
      const body = buildPrBody({
        issue: { ...ref, title: issue.title },
        rootCause: state.submission.root_cause,
        summary: state.submission.summary,
        testFile: state.submission.test_file,
        changedFiles: files,
        before: { command: state.repro.command, summary: state.repro.summary, output: state.repro.output },
        after: { command: state.finalTestRun.command, summary: state.finalTestRun.summary, output: state.finalTestRun.output },
        baseline: baseline.tests,
        lintOutput: state.lintOutput,
        steps: agent.turns,
        totals: agent.totals,
        model: llm.model,
        provider: llm.name,
        durationMs: Date.now() - started,
        runId,
      });
      const title = prTitle({ ...ref, title: issue.title });
      fs.writeFileSync(path.join(runDir, "pr.md"), `# ${title}\n\n${body}`);
      result.prFile = path.join(runDir, "pr.md");

      if (dryRun) {
        log("dry run: skipping commit, push and pull request");
        result.detail = "dry run: fix verified, PR body written to pr.md";
      } else {
        let finalBranch = branch;
        for (let i = 2; await github.branchExists(ref, finalBranch); i++) finalBranch = `${branch}-${i}`;
        result.branch = finalBranch;
        const push = await commitAndPush({
          repoDir,
          branch: finalBranch,
          baseBranch,
          commitMessage: conventionalCommitMessage({ ...ref, title: issue.title }, state.submission.summary),
          authHeader: github.pushAuthHeader(),
          remoteUrl: issue.cloneUrl,
        });
        result.pushed = push.pushed;
        if (push.pushed || github.kind === "local") {
          try {
            const pr = await github.createPullRequest({ ref, head: finalBranch, base: baseBranch, title, body, labels: [AI_LABEL] });
            result.pr = { url: pr.url, number: pr.number };
            log(`pull request: ${pr.url}`);
          } catch (err) {
            // The fix is verified and the branch is on the remote; a PR-creation
            // failure (permissions, rate limit) must not erase that.
            const message = err instanceof Error ? err.message : String(err);
            result.detail = `fix verified and pushed to ${finalBranch}, but opening the PR failed (${message}); body written to ${result.prFile}`;
            trajectory.warn(result.detail);
            log(result.detail);
          }
        } else {
          result.detail = `fix verified but push was not possible (${push.error}); PR body written to ${result.prFile}`;
          log(result.detail);
        }
      }
    } else if (
      agent.outcome === "not_reproduced" ||
      agent.outcome === "refusal" ||
      (!result.reproduced && (agent.outcome === "stalled" || agent.outcome === "max_steps" || agent.outcome === "budget_exceeded"))
    ) {
      // Stopped before a failing test existed: tell the humans what was tried, open nothing.
      const comment = notReproducedComment(issue, agent.detail + (agent.refusal?.explanation ? ` (${agent.refusal.explanation})` : ""), state.commandsTried, runId);
      fs.writeFileSync(path.join(runDir, "issue-comment.md"), comment);
      if (!dryRun) {
        await github.commentOnIssue(ref, comment);
        log("commented on the issue; no pull request opened");
      } else {
        log("dry run: would comment on the issue; no pull request");
      }
    } else {
      log(`stopped: ${agent.outcome} (${agent.detail})`);
    }
  } catch (err) {
    result.outcome = "error";
    result.detail = err instanceof Error ? err.message : String(err);
    trajectory.log({ type: "limit", kind: "error", detail: result.detail });
    log(`error: ${result.detail}`);
  } finally {
    if (sandbox) await sandbox.destroy();
    result.durationMs = Date.now() - started;
    trajectory.log({
      type: "run_end",
      outcome: result.outcome,
      summary: {
        detail: result.detail,
        reproduced: result.reproduced,
        fixed: result.fixed,
        suiteGreen: result.suiteGreen,
        steps: result.steps,
        totals: result.totals,
        durationMs: result.durationMs,
        prUrl: result.pr?.url ?? null,
        branch: result.branch,
        changedFiles: result.changedFiles,
      },
    });
    trajectory.close();
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(result, null, 2));
  }
  return result;
}
