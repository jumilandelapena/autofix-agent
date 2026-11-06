/**
 * Turn a real run into a mock fixture:
 *   pnpm fixture:from-run runs/<id>/trajectory.jsonl [evals/fixtures/mock/issue-N.json]
 *
 * Only the assistant turns (`api_response` events) are kept. Tool results are
 * recomputed at replay time, so the fixture stays honest: a replay passes
 * only if the recorded edits still apply and the tests still flip.
 */
import fs from "node:fs";
import path from "node:path";
import { readTrajectory } from "../src/trajectory/logger.js";

const [, , input, output] = process.argv;
if (!input) {
  console.error("usage: pnpm fixture:from-run runs/<id>/trajectory.jsonl [out.json]");
  process.exit(2);
}

const events = readTrajectory(path.resolve(input));
const start = events.find((e) => e.type === "run_start");
if (!start || start.type !== "run_start") throw new Error("trajectory has no run_start event");
const turns = events
  .filter((e) => e.type === "api_response")
  .map((e) => (e.type === "api_response" ? { content: e.content, stop_reason: e.stop_reason, usage: e.usage } : null))
  .filter(Boolean);

const fixture = {
  issue: start.issue.number,
  repo: start.issue.url,
  description: start.issue.title,
  model: (start.options["model"] as string | undefined) ?? "claude-opus-5-5",
  recorded: `from ${path.basename(path.dirname(path.resolve(input)))} at ${start.ts}`,
  turns,
};
const out = path.resolve(output ?? `evals/fixtures/mock/issue-${start.issue.number}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${turns.length} turns to ${out}`);
