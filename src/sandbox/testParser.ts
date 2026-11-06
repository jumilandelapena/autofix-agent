/**
 * Parses the text output of vitest, jest, pytest and `go test` into a
 * pass/fail summary. The agent sees this summary (plus the tail of the raw
 * output) instead of thousands of lines of reporter noise.
 */
import type { TestFramework } from "./detect.js";

export interface TestSummary {
  framework: TestFramework;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** Names of failing tests, as far as the reporter prints them. */
  failedTests: string[];
  /** True when the counts came from the reporter rather than the exit code. */
  parsed: boolean;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

function uniq(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}

function countsFromPairs(line: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending|errors?|xfailed|xpassed|deselected|warnings?)/g)) {
    const key = m[2]!.replace(/s$/, "").replace("warning", "warning");
    out[key] = (out[key] ?? 0) + Number(m[1]);
  }
  return out;
}

export function parseVitest(output: string): TestSummary | null {
  const text = stripAnsi(output);
  const line = [...text.matchAll(/^\s*Tests\s+(.+)$/gm)].map((m) => m[1]!).pop();
  if (!line) return null;
  const c = countsFromPairs(line);
  // The failure summary ("FAIL file > suite > name") is the precise source;
  // the tree view ("× name") is only a fallback for reporters that omit it.
  const fromSummary = uniq([...text.matchAll(/^\s*FAIL\s+(\S+\s*>\s*.+?)\s*$/gm)].map((m) => m[1]!));
  const fromTree = uniq([...text.matchAll(/^\s*[×✗]\s+(.+?)(?:\s+\d+\s*ms)?\s*$/gm)].map((m) => m[1]!));
  const failedTests = fromSummary.length ? fromSummary : fromTree;
  const passed = c["passed"] ?? 0;
  const failed = c["failed"] ?? 0;
  const skipped = (c["skipped"] ?? 0) + (c["todo"] ?? 0);
  return { framework: "vitest", passed, failed, skipped, total: passed + failed + skipped, failedTests, parsed: true };
}

export function parseJest(output: string): TestSummary | null {
  const text = stripAnsi(output);
  const line = [...text.matchAll(/^\s*Tests:\s+(.+)$/gm)].map((m) => m[1]!).pop();
  if (!line) return null;
  const c = countsFromPairs(line);
  const failedTests = uniq([...text.matchAll(/^\s*●\s+(.+?)\s*$/gm)].map((m) => m[1]!).filter((n) => !/^Test suite failed/.test(n)));
  const passed = c["passed"] ?? 0;
  const failed = c["failed"] ?? 0;
  const skipped = (c["skipped"] ?? 0) + (c["todo"] ?? 0) + (c["pending"] ?? 0);
  return { framework: "jest", passed, failed, skipped, total: passed + failed + skipped, failedTests, parsed: true };
}

export function parsePytest(output: string): TestSummary | null {
  const text = stripAnsi(output);
  const line = [...text.matchAll(/^=+\s+(.*?)\s+in\s+[\d.]+s.*=+\s*$/gm)].map((m) => m[1]!).pop();
  if (!line) {
    if (/no tests ran/.test(text)) {
      return { framework: "pytest", passed: 0, failed: 0, skipped: 0, total: 0, failedTests: [], parsed: true };
    }
    return null;
  }
  const c = countsFromPairs(line);
  const failedTests = uniq([...text.matchAll(/^(?:FAILED|ERROR)\s+(\S+)(?:\s+-\s+.*)?$/gm)].map((m) => m[1]!));
  const passed = c["passed"] ?? 0;
  const failed = (c["failed"] ?? 0) + (c["error"] ?? 0);
  const skipped = (c["skipped"] ?? 0) + (c["xfailed"] ?? 0) + (c["deselected"] ?? 0);
  return { framework: "pytest", passed, failed, skipped, total: passed + failed + skipped, failedTests, parsed: true };
}

export function parseGoTest(output: string): TestSummary | null {
  const text = stripAnsi(output);
  const passLines = [...text.matchAll(/^\s*--- PASS: (\S+)/gm)].map((m) => m[1]!);
  const failLines = [...text.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]!);
  const skipLines = [...text.matchAll(/^\s*--- SKIP: (\S+)/gm)].map((m) => m[1]!);
  const okPkgs = [...text.matchAll(/^ok\s+(\S+)/gm)].map((m) => m[1]!);
  const failPkgs = [...text.matchAll(/^FAIL\s+(\S+)(?:\s|$)/gm)].map((m) => m[1]!).filter((p) => p !== "FAIL");
  if (passLines.length + failLines.length + okPkgs.length + failPkgs.length === 0) return null;
  // Without -v, go only prints per-package lines; count packages then.
  const verbose = passLines.length + failLines.length > 0;
  const passed = verbose ? passLines.length : okPkgs.length;
  const failed = verbose ? failLines.length : failPkgs.length;
  const skipped = skipLines.length;
  const failedTests = uniq(verbose ? failLines : failPkgs);
  return { framework: "gotest", passed, failed, skipped, total: passed + failed + skipped, failedTests, parsed: true };
}

/**
 * Parse test output. Tries the hinted framework first, then every parser,
 * then falls back to the exit code so the agent always gets a number.
 */
export function parseTestOutput(output: string, exitCode: number, hint: TestFramework = "unknown"): TestSummary {
  const parsers: Array<[TestFramework, (s: string) => TestSummary | null]> = [
    ["vitest", parseVitest],
    ["jest", parseJest],
    ["pytest", parsePytest],
    ["gotest", parseGoTest],
  ];
  parsers.sort((a, b) => (a[0] === hint ? -1 : b[0] === hint ? 1 : 0));
  for (const [, parse] of parsers) {
    const result = parse(output);
    if (result) return result;
  }
  const ok = exitCode === 0;
  return {
    framework: hint,
    passed: ok ? 1 : 0,
    failed: ok ? 0 : 1,
    skipped: 0,
    total: 1,
    failedTests: ok ? [] : ["(unparsed test output; command exited with code " + exitCode + ")"],
    parsed: false,
  };
}

export function formatSummary(s: TestSummary): string {
  const parts = [`${s.passed} passed`, `${s.failed} failed`];
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  const head = `${parts.join(", ")} (${s.total} total${s.parsed ? "" : ", from exit code"})`;
  if (s.failedTests.length === 0) return head;
  const names = s.failedTests.slice(0, 20).map((n) => `  - ${n}`);
  if (s.failedTests.length > 20) names.push(`  - ... ${s.failedTests.length - 20} more`);
  return `${head}\nfailing:\n${names.join("\n")}`;
}

/** Tests that fail now but passed (or did not exist) in the baseline. */
export function newFailures(baseline: TestSummary, current: TestSummary): string[] {
  const before = new Set(baseline.failedTests);
  return current.failedTests.filter((t) => !before.has(t));
}
