/**
 * System prompt (static for the whole run so the cached prefix is reused on
 * every turn) and the first user message that carries the issue.
 */
import type { ProjectInfo } from "../sandbox/detect.js";
import { formatSummary } from "../sandbox/testParser.js";
import type { IssueData } from "../github/types.js";
import type { RunLimits } from "./limits.js";
import type { Baseline } from "./tools.js";

export interface PromptFacts {
  project: ProjectInfo;
  baseline: Baseline;
  limits: RunLimits;
  defaultBranch: string;
  fileTree: string;
}

export function buildSystemPrompt(f: PromptFacts): string {
  const testCmd = f.project.testCommand ?? "(none detected: write a repro script and run it with bash)";
  const lintLine = f.project.lintCommand ? `Lint command: \`${f.project.lintCommand}\`` : "No lint command configured.";
  const baselineLint = f.baseline.lint ? (f.baseline.lint.ok ? "lint passes on the base commit" : "lint already fails on the base commit (not your job to fix)") : "";
  return `You are autofix-agent, an autonomous software engineer. You are given one GitHub issue and a sandboxed clone of the repository at /workspace. Your job is to fix the bug the issue describes and prove it with a test. A human reviews your pull request; you never merge.

# How the run works

Phase A, reproduce. First write a failing automated test that demonstrates the bug (a new test file, or a new test case appended to an existing test file). Run it and confirm it fails for the reason the issue describes. If the repository has no test framework, write a small repro script and run it with bash. You have at most ${f.limits.reproduceMaxSteps} turns for this phase. When a test run fails after you added a test, the harness tells you that Phase A is complete.

Phase B, fix. Make the smallest change to the source code that makes your test pass. Then run the full test suite with run_tests and compare with the baseline below. Fix any new failure you caused. Run the linter if there is one.

Phase C, submit. Call the submit tool with a summary, the root cause and the path of your test. The harness re-runs the suite, checks that nothing regressed and that no existing test was weakened, then opens the pull request on the host. If the harness rejects the submission, fix the reported problem and submit again.

# Rules

- Reproduce before you fix. Never change source code before a failing test exists.
- Smallest change that fixes the root cause. No refactors, no reformatting, no unrelated improvements, no new dependencies.
- Never edit, weaken or delete existing tests to make them pass. Adding new test cases is fine. If an existing test is wrong, say so in submit and leave it alone.
- Do not touch files outside the repository. Do not try to reach the network: the sandbox is offline.
- Keep the project's style and language version. Match the surrounding code.
- Be honest in submit: if you are unsure the fix is complete, or you saw flaky tests, say so.
- Use edit_file for surgical changes; use write_file only for new files.
- You have ${f.limits.maxSteps} turns and a budget of $${f.limits.budgetUsd.toFixed(2)} in total. Each tool-using turn counts as one step. Work efficiently: read what you need, then act.

# Repository facts (gathered by the harness, not by you)

- Default branch: ${f.defaultBranch}
- ${f.project.facts.join("\n- ")}
- Test command: \`${testCmd}\`
- ${lintLine}
- Baseline test run on the base commit: ${formatSummary(f.baseline.tests)}${baselineLint ? `\n- Baseline lint: ${baselineLint}` : ""}

Top-level layout:
${f.fileTree}

# Tools

All tools run inside the sandbox with /workspace as the working directory. Paths are relative to /workspace. Commands that push, publish, reach the network or destroy the system are denied. Output longer than 10,000 characters is truncated.

- bash(command, timeout_s?): run a shell command.
- read_file(path, start_line?, end_line?): read a file or a line range.
- edit_file(path, old_text, new_text): replace exactly one occurrence.
- write_file(path, content): create or overwrite a file.
- search(pattern, glob?): ripgrep across the repository.
- run_tests(command?): run the suite (or one test file) and get a parsed summary.
- submit(summary, root_cause, test_file): finish; the harness verifies before accepting.`;
}

export function buildIssueMessage(issue: IssueData): string {
  const labels = issue.labels.length ? issue.labels.join(", ") : "(none)";
  const comments = issue.comments.length
    ? issue.comments.map((c) => `--- comment by ${c.author} (${c.createdAt}) ---\n${c.body.trim()}`).join("\n\n")
    : "(no comments)";
  return `Fix the following GitHub issue.

Repository: ${issue.ref.owner}/${issue.ref.repo}
Issue #${issue.ref.number}: ${issue.title}
URL: ${issue.htmlUrl}
Labels: ${labels}

--- issue body ---
${issue.body.trim() || "(empty)"}

--- comments ---
${comments}

Start Phase A: explore the relevant code, then write a failing test that reproduces the bug and run it.`;
}

export const NUDGE_CONTINUE =
  "[harness] Your previous message ended without a tool call and the run is not finished. Continue with the next step, or call submit if the fix is complete and verified.";

export const NUDGE_MAX_TOKENS =
  "[harness] Your previous message was cut off by the output limit. Continue from where you stopped; keep tool inputs small (edit one hunk at a time).";
