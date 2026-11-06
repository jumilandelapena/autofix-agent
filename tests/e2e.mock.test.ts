/**
 * End to end with the mock provider against demo-repo: the recorded turns
 * are replayed, but every tool call, the baseline, the phase logic, the
 * harness verification and the patch export are real.
 *
 * Uses the local sandbox so it runs anywhere; CI's e2e-mock job runs the same
 * pipeline through the Docker sandbox.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFix } from "../src/run.js";
import { readTrajectory } from "../src/trajectory/logger.js";

const root = path.resolve(import.meta.dirname, "..");
const runsDir = path.join(root, "runs", "vitest");

/** Drop the volatile `index abc..def` lines so the diff compares across git versions. */
export function normalizeDiff(diff: string): string {
  return diff
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^index [0-9a-f]+\.\.[0-9a-f]+/.test(l))
    .join("\n")
    .trim();
}

describe("mock end-to-end on demo-repo", () => {
  it(
    "reproduces, fixes, keeps the suite green and produces the recorded diff (issue #1)",
    async () => {
      const result = await runFix({
        issue: "jumilandelapena/demo-inventory-api#1",
        provider: "mock",
        sandbox: "local",
        dryRun: true,
        repoPath: path.join(root, "demo-repo"),
        issuesFile: path.join(root, "demo-repo/issues.json"),
        runsDir,
      });

      expect(result.outcome, result.detail).toBe("submitted");
      expect(result.reproduced).toBe(true);
      expect(result.fixed).toBe(true);
      expect(result.suiteGreen).toBe(true);
      expect(result.baseline).toMatchObject({ passed: 16, failed: 0 });
      expect(result.after).toMatchObject({ passed: 19, failed: 0 });
      expect(result.changedFiles).toEqual(["src/utils.ts", "tests/issue-1-pagination.test.ts"]);
      expect(result.steps).toBe(7);
      expect(result.totals.costUsd).toBe(0);

      // A failing test was written and seen failing before the fix.
      const events = readTrajectory(path.join(result.runDir, "trajectory.jsonl"));
      const phase = events.find((e) => e.type === "phase" && e.to === "fix");
      expect(phase).toBeDefined();
      const reproResult = events.find((e) => e.type === "tool_result" && e.name === "run_tests" && /3 failed/.test(e.content));
      expect(reproResult).toBeDefined();
      const verification = events.filter((e) => e.type === "verification");
      expect(verification.every((e) => e.type === "verification" && e.ok)).toBe(true);
      expect(verification.map((e) => (e.type === "verification" ? e.stage : ""))).toEqual(["tests-untouched", "suite", "lint"]);

      // The diff matches the recorded one.
      const expected = fs.readFileSync(path.join(root, "evals/fixtures/mock/issue-1.diff"), "utf8");
      expect(normalizeDiff(result.diff)).toBe(normalizeDiff(expected));

      // Dry run: PR body written, nothing pushed.
      expect(result.pr).toBeNull();
      expect(result.pushed).toBe(false);
      const pr = fs.readFileSync(path.join(result.runDir, "pr.md"), "utf8");
      expect(pr).toContain("Closes #1");
      expect(pr).toContain("0 passed, 3 failed");
      expect(pr).toContain("19 passed, 0 failed");
      expect(fs.existsSync(path.join(result.runDir, "trajectory.html"))).toBe(true);
    },
    10 * 60_000,
  );

  it(
    "detects a repro test created through bash (heredoc), not only through write_file (issue #6)",
    async () => {
      // Found by the first live run: the real model wrote its test with
      // `cat > file <<'EOF'`, and Phase A never completed.
      const fixture = path.join(runsDir, "heredoc-fixture.json");
      fs.mkdirSync(runsDir, { recursive: true });
      const test = [
        'import { describe, expect, it } from "vitest";',
        'import { slugify } from "../src/utils.js";',
        'describe("issue #6", () => { it("trims hyphens", () => { expect(slugify("Hello World!")).toBe("hello-world"); }); });',
      ].join("\n");
      fs.writeFileSync(
        fixture,
        JSON.stringify({
          issue: 6,
          turns: [
            {
              content: [
                { type: "tool_use", id: "h1", name: "bash", input: { command: `cat > tests/issue-6-heredoc.test.ts <<'EOF'\n${test}\nEOF` } },
                { type: "tool_use", id: "h2", name: "run_tests", input: { command: "npx vitest run tests/issue-6-heredoc.test.ts" } },
              ],
              stop_reason: "tool_use",
            },
            {
              content: [
                {
                  type: "tool_use",
                  id: "h3",
                  name: "edit_file",
                  input: {
                    path: "src/utils.ts",
                    old_text: '  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");',
                    new_text: '  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");',
                  },
                },
                { type: "tool_use", id: "h4", name: "run_tests", input: {} },
              ],
              stop_reason: "tool_use",
            },
            {
              content: [{ type: "tool_use", id: "h5", name: "submit", input: { summary: "trim", root_cause: "missing trim", test_file: "tests/issue-6-heredoc.test.ts" } }],
              stop_reason: "tool_use",
            },
          ],
        }),
      );
      const result = await runFix({
        issue: "jumilandelapena/demo-inventory-api#6",
        provider: "mock",
        fixture,
        sandbox: "local",
        dryRun: true,
        repoPath: path.join(root, "demo-repo"),
        issuesFile: path.join(root, "demo-repo/issues.json"),
        runsDir,
      });
      expect(result.outcome, result.detail).toBe("submitted");
      expect(result.reproduced).toBe(true);
      expect(result.steps).toBe(3);
      expect(result.changedFiles).toEqual(["src/utils.ts", "tests/issue-6-heredoc.test.ts"]);
    },
    10 * 60_000,
  );

  it(
    "stops with a comment, not a PR, when the recording never reproduces the bug",
    async () => {
      const fixture = path.join(runsDir, "no-repro-fixture.json");
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(
        fixture,
        JSON.stringify({
          issue: 6,
          turns: [
            { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "src/utils.ts" } }], stop_reason: "tool_use" },
            { content: [{ type: "text", text: "I could not find the bug." }], stop_reason: "end_turn" },
            { content: [{ type: "text", text: "Still nothing." }], stop_reason: "end_turn" },
            { content: [{ type: "text", text: "Giving up." }], stop_reason: "end_turn" },
          ],
        }),
      );
      const result = await runFix({
        issue: "jumilandelapena/demo-inventory-api#6",
        provider: "mock",
        fixture,
        sandbox: "local",
        dryRun: true,
        repoPath: path.join(root, "demo-repo"),
        issuesFile: path.join(root, "demo-repo/issues.json"),
        runsDir,
      });
      expect(result.outcome).toBe("stalled");
      expect(result.reproduced).toBe(false);
      expect(result.pr).toBeNull();
      expect(result.diff).toBe("");
    },
    10 * 60_000,
  );
});
