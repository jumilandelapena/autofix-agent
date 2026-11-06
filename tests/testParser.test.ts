import { describe, expect, it } from "vitest";
import { formatSummary, newFailures, parseGoTest, parseJest, parsePytest, parseTestOutput, parseVitest } from "../src/sandbox/testParser.js";

const vitestFail = `
 RUN  v5.1.0 /workspace

 ❯ tests/issue-1-pagination.test.ts (3 tests | 2 failed) 41ms
   × issue #1 > paginate returns at most limit items 5ms
   × issue #1 > GET /items?limit=2 returns exactly 2 items 30ms
   ✓ issue #1 > pages do not overlap 6ms
 ✓ tests/utils.test.ts (7 tests) 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/issue-1-pagination.test.ts > issue #1 > paginate returns at most limit items
AssertionError: expected [ 1, 2, 3 ] to deeply equal [ 1, 2 ]

 FAIL  tests/issue-1-pagination.test.ts > issue #1 > GET /items?limit=2 returns exactly 2 items
AssertionError: expected 3 to be 2

 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 8 passed (10)
   Start at  21:15:40
   Duration  812ms
`;

const vitestPass = `
 ✓ tests/app.test.ts (9 tests) 120ms
 ✓ tests/utils.test.ts (7 tests) 4ms

 Test Files  2 passed (2)
      Tests  16 passed | 1 skipped (17)
   Start at  21:15:40
   Duration  600ms (transform 50ms, setup 0ms, collect 200ms, tests 124ms)
`;

const jestOut = `
PASS src/a.test.js
FAIL src/b.test.js
  ● math › adds

    expect(received).toBe(expected)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 1 skipped, 4 passed, 6 total
Snapshots:   0 total
Time:        1.2 s
`;

const pytestOut = `
============================= test session starts ==============================
collected 5 items

tests/test_api.py ..F.                                                   [ 80%]
tests/test_utils.py s                                                    [100%]

=================================== FAILURES ===================================
____________________________ test_limit_returns_n ______________________________
    assert len(items) == 2
E   assert 3 == 2
FAILED tests/test_api.py::test_limit_returns_n - assert 3 == 2
=================== 1 failed, 3 passed, 1 skipped in 0.12s =====================
`;

const goVerbose = `
=== RUN   TestPaginate
--- FAIL: TestPaginate (0.00s)
    utils_test.go:12: got 3 items, want 2
=== RUN   TestSlugify
--- PASS: TestSlugify (0.00s)
=== RUN   TestSkipped
--- SKIP: TestSkipped (0.00s)
FAIL
FAIL	example.com/demo/utils	0.004s
ok  	example.com/demo/store	0.002s
`;

const goQuiet = `
ok  	example.com/demo/store	0.002s
--- FAIL: TestPaginate (0.00s)
FAIL
FAIL	example.com/demo/utils	0.004s
`;

describe("vitest parser", () => {
  it("counts failures and names them", () => {
    const s = parseVitest(vitestFail)!;
    expect(s).toMatchObject({ framework: "vitest", passed: 8, failed: 2, total: 10, parsed: true });
    expect(s.failedTests).toContain("tests/issue-1-pagination.test.ts > issue #1 > paginate returns at most limit items");
    expect(s.failedTests.some((t) => t.includes("GET /items?limit=2"))).toBe(true);
  });

  it("handles the all-green form with skipped", () => {
    expect(parseVitest(vitestPass)).toMatchObject({ passed: 16, failed: 0, skipped: 1, total: 17, failedTests: [] });
  });

  it("returns null for unrelated output", () => {
    expect(parseVitest("nothing here")).toBeNull();
  });
});

describe("jest parser", () => {
  it("parses the Tests: line and bullet names", () => {
    const s = parseJest(jestOut)!;
    expect(s).toMatchObject({ framework: "jest", passed: 4, failed: 1, skipped: 1, total: 6 });
    expect(s.failedTests).toEqual(["math › adds"]);
  });
});

describe("pytest parser", () => {
  it("parses the summary line and FAILED entries", () => {
    const s = parsePytest(pytestOut)!;
    expect(s).toMatchObject({ framework: "pytest", passed: 3, failed: 1, skipped: 1, total: 5 });
    expect(s.failedTests).toEqual(["tests/test_api.py::test_limit_returns_n"]);
  });

  it("handles 'no tests ran'", () => {
    expect(parsePytest("no tests ran in 0.01s")).toMatchObject({ passed: 0, failed: 0, total: 0 });
  });
});

describe("go test parser", () => {
  it("uses --- PASS/FAIL lines when verbose", () => {
    const s = parseGoTest(goVerbose)!;
    expect(s).toMatchObject({ framework: "gotest", passed: 1, failed: 1, skipped: 1, total: 3 });
    expect(s.failedTests).toEqual(["TestPaginate"]);
  });

  it("falls back to package lines", () => {
    const s = parseGoTest(goQuiet)!;
    expect(s.failed).toBe(1);
    expect(s.failedTests).toEqual(["TestPaginate"]);
  });
});

describe("parseTestOutput", () => {
  it("prefers the hinted framework and falls back to the exit code", () => {
    expect(parseTestOutput(pytestOut, 1, "pytest").framework).toBe("pytest");
    expect(parseTestOutput(vitestPass, 0, "pytest").framework).toBe("vitest");
    const unknown = parseTestOutput("random text", 1, "unknown");
    expect(unknown).toMatchObject({ parsed: false, failed: 1, passed: 0 });
    expect(parseTestOutput("random text", 0, "unknown")).toMatchObject({ parsed: false, failed: 0, passed: 1 });
  });

  it("formats a summary and detects new failures", () => {
    const before = parseVitest(vitestPass)!;
    const after = parseVitest(vitestFail)!;
    expect(formatSummary(after)).toMatch(/^8 passed, 2 failed \(10 total\)\nfailing:/);
    expect(newFailures(before, after)).toHaveLength(2);
    expect(newFailures(after, after)).toHaveLength(0);
  });
});
