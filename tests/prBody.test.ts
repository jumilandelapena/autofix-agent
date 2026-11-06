import { describe, expect, it } from "vitest";
import { buildPrBody, conventionalCommitMessage, prTitle, type PrBodyInput } from "../src/github/prBody.js";
import type { TestSummary } from "../src/sandbox/testParser.js";

const summary = (passed: number, failed: number, failedTests: string[] = []): TestSummary => ({
  framework: "vitest",
  passed,
  failed,
  skipped: 0,
  total: passed + failed,
  failedTests,
  parsed: true,
});

const input: PrBodyInput = {
  issue: { owner: "o", repo: "r", number: 1, url: "https://github.com/o/r/issues/1", title: "GET /items?limit=N returns N+1 items." },
  rootCause: "Off-by-one in paginate().",
  summary: "Slice end is now offset + limit.",
  testFile: "tests/issue-1-pagination.test.ts",
  changedFiles: ["src/utils.ts", "tests/issue-1-pagination.test.ts"],
  before: { command: "npx vitest run tests/issue-1-pagination.test.ts", summary: summary(0, 3, ["a", "b", "c"]), output: "BEFORE-LINE-1\nAssertionError: expected 3 to be 2\n Tests  3 failed (3)" },
  after: { command: "npx vitest run", summary: summary(19, 0), output: "AFTER-LINE-1\n Tests  19 passed (19)" },
  baseline: summary(16, 0),
  lintOutput: "exit code 0",
  steps: 7,
  totals: { inputTokens: 12_000, outputTokens: 3_000, cacheWriteTokens: 4_000, cacheReadTokens: 40_000, costUsd: 0.1234, turns: 7 },
  model: "claude-opus-5-5",
  provider: "anthropic",
  durationMs: 95_000,
  runId: "20261106-120000-issue-1",
};

describe("buildPrBody", () => {
  const body = buildPrBody(input);

  it("renders root cause, change list and the new test", () => {
    expect(body).toContain("## Root cause\n\nOff-by-one in paginate().");
    expect(body).toContain("- `src/utils.ts`");
    expect(body).toContain("`tests/issue-1-pagination.test.ts` reproduces the issue");
  });

  it("renders before and after test output", () => {
    expect(body).toContain("**Before** (`npx vitest run tests/issue-1-pagination.test.ts`): 0 passed, 3 failed (3 total)");
    expect(body).toContain("AssertionError: expected 3 to be 2");
    expect(body).toContain("**After** (`npx vitest run`): 19 passed, 0 failed (19 total)");
    expect(body).toContain("AFTER-LINE-1");
    expect(body).toContain("Baseline on the base commit: 16 passed, 0 failed (16 total)");
  });

  it("renders steps, tokens, cost and closes the issue", () => {
    expect(body).toMatch(/\| 7 \| 56,000 \| 3,000 \| 40,000 \| \$0\.1234 \| 1\.6 min \| claude-opus-5-5 \|/);
    expect(body).toContain("Closes #1");
    expect(body).toContain("autofix-agent");
  });

  it("includes the review checklist and the human-review warning", () => {
    expect(body).toContain("## Review checklist");
    expect(body).toContain("- [ ] The new test would have caught the bug");
    expect(body).toContain("A human must review before merging");
  });

  it("marks mock replays and trims long output", () => {
    const long = { ...input, provider: "mock", after: { ...input.after, output: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") } };
    const mockBody = buildPrBody(long);
    expect(mockBody).toContain("(mock replay)");
    expect(mockBody).toContain("(60 earlier lines omitted)");
    expect(mockBody).not.toContain("line 10\n");
    expect(mockBody).toContain("line 99");
  });
});

describe("titles and commit messages", () => {
  it("follows Conventional Commits and lower-cases the subject", () => {
    expect(prTitle(input.issue)).toBe("fix: GET /items?limit=N returns N+1 items (#1)");
    expect(prTitle({ ...input.issue, title: "Search is case-sensitive" })).toBe("fix: search is case-sensitive (#1)");
    const msg = conventionalCommitMessage(input.issue, "Slice end is now offset + limit.");
    expect(msg.split("\n")[0]).toMatch(/^fix: /);
    expect(msg).toContain("\n\nCloses #1");
  });
});
