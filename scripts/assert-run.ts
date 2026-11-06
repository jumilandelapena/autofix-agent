/**
 * CI guard for the e2e-mock job: the newest run under <runsDir> must have
 * been submitted, left the suite green and produced a non-empty diff.
 *   pnpm tsx scripts/assert-run.ts runs
 */
import fs from "node:fs";
import path from "node:path";

const runsDir = path.resolve(process.argv[2] ?? "runs");
const dirs = fs
  .readdirSync(runsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(runsDir, d.name, "summary.json")))
  .map((d) => d.name)
  .sort();
const latest = dirs[dirs.length - 1];
if (!latest) {
  console.error(`no run with summary.json under ${runsDir}`);
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(path.join(runsDir, latest, "summary.json"), "utf8")) as {
  outcome: string;
  detail: string;
  suiteGreen: boolean;
  reproduced: boolean;
  diff: string;
  changedFiles: string[];
  after: { passed: number; failed: number } | null;
};

const checks: Array<[string, boolean]> = [
  [`outcome is submitted (got ${summary.outcome}: ${summary.detail})`, summary.outcome === "submitted"],
  ["bug was reproduced by a failing test", summary.reproduced],
  [`suite is green after the fix (${summary.after?.passed ?? "?"} passed, ${summary.after?.failed ?? "?"} failed)`, summary.suiteGreen && (summary.after?.failed ?? 1) === 0],
  [`diff is non-empty (${summary.diff.length} chars, ${summary.changedFiles.length} files)`, summary.diff.trim().length > 0],
  ["a source file changed, not only tests", summary.changedFiles.some((f) => !/(^|\/)tests?\//.test(f))],
];

let failed = false;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
console.log(`run: ${path.join(runsDir, latest)}`);
process.exit(failed ? 1 : 0);
