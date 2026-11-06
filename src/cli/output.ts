/**
 * Terminal rendering of agent turns, shared by the CLI and the eval runner.
 */
import chalk from "chalk";
import type { TurnInfo } from "../agent/loop.js";
import { formatUsd } from "../agent/pricing.js";

export function summarizeCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").slice(0, 90);
  switch (name) {
    case "bash":
      return `$ ${str(i["command"])}`;
    case "read_file":
    case "edit_file":
    case "write_file":
      return `${name} ${str(i["path"])}`;
    case "search":
      return `search /${str(i["pattern"])}/${i["glob"] ? ` in ${str(i["glob"])}` : ""}`;
    case "run_tests":
      return `run_tests ${str(i["command"] ?? "(default)")}`;
    case "submit":
      return "submit";
    default:
      return name;
  }
}

export function printTurn(info: TurnInfo): void {
  const phase = info.phase === "reproduce" ? "A" : info.phase === "fix" ? "B" : "C";
  const head = chalk.dim(
    `[turn ${String(info.turn).padStart(2)} | phase ${phase} | ${formatUsd(info.totals.costUsd)} | cache ${info.usage.cache_read_input_tokens ?? 0}${info.contextEditing ? " | ctx-edit" : ""}]`,
  );
  if (info.text.trim()) console.log(`${head} ${chalk.white(info.text.trim().split("\n")[0]!.slice(0, 120))}`);
  for (let k = 0; k < info.toolCalls.length; k++) {
    const call = info.toolCalls[k]!;
    const res = info.toolResults[k];
    const status = res ? (res.isError ? chalk.red("error") : chalk.green("ok")) : chalk.yellow("skipped");
    console.log(`${head} ${chalk.cyan(summarizeCall(call.name, call.input))} ${status}`);
    if (res?.isError) console.log(chalk.red(`    ${res.content.split("\n")[0]!.slice(0, 160)}`));
    if (call.name === "run_tests" && res && !res.isError) {
      const summary = /summary: (.+)/.exec(res.content)?.[1];
      if (summary) console.log(`    ${chalk.magenta(summary)}`);
    }
  }
}
