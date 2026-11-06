/**
 * Renders the pull request title and body. Everything in the body comes
 * from recorded facts (test output, usage, trajectory), not from the model's
 * self-assessment alone.
 */
import type { UsageTotals } from "../agent/pricing.js";
import { formatSummary, type TestSummary } from "../sandbox/testParser.js";
import type { IssueRef } from "./issueRef.js";

export interface PrBodyInput {
  issue: IssueRef & { title: string };
  rootCause: string;
  summary: string;
  testFile: string;
  changedFiles: string[];
  before: { command: string; summary: TestSummary; output: string };
  after: { command: string; summary: TestSummary; output: string };
  baseline: TestSummary;
  lintOutput: string | null;
  steps: number;
  totals: UsageTotals;
  model: string;
  provider: string;
  durationMs: number;
  runId: string;
  uncertainty?: string | undefined;
}

export const AI_LABEL = "ai-generated";

const MAX_OUTPUT_LINES = 40;

function tail(text: string, lines = MAX_OUTPUT_LINES): string {
  const all = text.trim().split("\n");
  const kept = all.slice(-lines);
  const prefix = all.length > lines ? `... (${all.length - lines} earlier lines omitted)\n` : "";
  return prefix + kept.join("\n");
}

function fence(text: string): string {
  return "```text\n" + text.replace(/```/g, "'''") + "\n```";
}

/** Lower-case a leading capitalised word, but leave acronyms such as "GET" alone. */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export function conventionalCommitMessage(issue: PrBodyInput["issue"], summary: string): string {
  const subject = issue.title.trim().replace(/\.$/, "");
  const short = subject.length > 60 ? subject.slice(0, 57).trimEnd() + "..." : subject;
  return `fix: ${lowerFirst(short)}\n\n${summary.trim()}\n\nCloses #${issue.number}`;
}

export function prTitle(issue: PrBodyInput["issue"]): string {
  const subject = issue.title.trim().replace(/\.$/, "");
  return `fix: ${lowerFirst(subject)} (#${issue.number})`;
}

export function buildPrBody(i: PrBodyInput): string {
  const minutes = (i.durationMs / 60000).toFixed(1);
  const totalPrompt = i.totals.inputTokens + i.totals.cacheReadTokens + i.totals.cacheWriteTokens;
  const files = i.changedFiles.length ? i.changedFiles.map((f) => `- \`${f}\``).join("\n") : "- (none)";
  const uncertainty = i.uncertainty?.trim() ? `\n> **Agent note:** ${i.uncertainty.trim()}\n` : "";
  const lint = i.lintOutput ? `\n<details><summary>Lint output</summary>\n\n${fence(tail(i.lintOutput, 30))}\n\n</details>\n` : "";
  return `> Opened automatically by [autofix-agent](https://github.com/jumilandelapena/autofix-agent) for #${i.issue.number}. A human must review before merging.
${uncertainty}
## Root cause

${i.rootCause.trim()}

## What changed

${i.summary.trim()}

${files}

## New test

\`${i.testFile}\` reproduces the issue: it fails on the base commit and passes with this change.

## Test output

**Before** (\`${i.before.command}\`): ${formatSummary(i.before.summary).split("\n")[0]}

<details><summary>Output before the fix</summary>

${fence(tail(i.before.output))}

</details>

**After** (\`${i.after.command}\`): ${formatSummary(i.after.summary).split("\n")[0]}

<details><summary>Output after the fix</summary>

${fence(tail(i.after.output))}

</details>

Baseline on the base commit: ${formatSummary(i.baseline).split("\n")[0]}.
${lint}
## Run stats

| Steps | Prompt tokens | Output tokens | Cache reads | Cost | Time | Model |
|---|---|---|---|---|---|---|
| ${i.steps} | ${totalPrompt.toLocaleString()} | ${i.totals.outputTokens.toLocaleString()} | ${i.totals.cacheReadTokens.toLocaleString()} | $${i.totals.costUsd.toFixed(4)} | ${minutes} min | ${i.model}${i.provider === "mock" ? " (mock replay)" : ""} |

Run id: \`${i.runId}\` (trajectory in \`runs/${i.runId}/trajectory.jsonl\`).

Closes #${i.issue.number}

## Review checklist

- [ ] The root cause above matches the issue, not just the symptom
- [ ] The new test would have caught the bug (it fails on the base commit)
- [ ] The change is minimal and does not alter unrelated behaviour
- [ ] No existing test was edited or deleted
- [ ] Naming and style match the surrounding code
`;
}
