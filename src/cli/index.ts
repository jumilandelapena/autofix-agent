#!/usr/bin/env node
/**
 * `pnpm fix <issue-url>` and friends.
 */
import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import { DEFAULT_RUN_LIMITS } from "../agent/limits.js";
import { formatUsd } from "../agent/pricing.js";
import { runFix } from "../run.js";
import { printTurn } from "./output.js";
import { DEFAULT_IMAGE, ensureSandboxImage } from "../sandbox/index.js";

const program = new Command();

function num(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("must be a positive number");
  return n;
}

program
  .name("autofix")
  .description("Mini SWE-agent: reproduce a GitHub issue in a sandbox, fix it, prove it, open a PR.")
  .version("1.0.0");

program
  .command("fix")
  .argument("<issue>", "https://github.com/owner/repo/issues/N or owner/repo#N")
  .option("--dry-run", "do everything except push and open the PR; print the diff", false)
  .option("--max-steps <n>", "maximum model turns", num, DEFAULT_RUN_LIMITS.maxSteps)
  .option("--budget-usd <n>", "spend cap in USD", num, DEFAULT_RUN_LIMITS.budgetUsd)
  .option("--base-image <tag>", `sandbox image (default ${DEFAULT_IMAGE})`)
  .option("--sandbox <kind>", "docker (default) or local (no isolation, dev only)")
  .option("--repo-path <dir>", "clone from a local directory instead of GitHub")
  .option("--issues-file <file>", "read the issue from a JSON file instead of GitHub (offline)")
  .option("--fixture <file>", "mock provider fixture (default evals/fixtures/mock/issue-<N>.json)")
  .option("--provider <name>", "anthropic or mock (default from LLM_PROVIDER)")
  .option("--model <id>", "model id (default claude-opus-5-5)")
  .option("--runs-dir <dir>", "where to write runs/<id>/", "runs")
  .action(async (issue: string, o) => {
    console.log(chalk.bold(`autofix-agent  ${issue}`));
    const result = await runFix({
      issue,
      dryRun: o.dryRun,
      maxSteps: o.maxSteps,
      budgetUsd: o.budgetUsd,
      baseImage: o.baseImage,
      sandbox: o.sandbox,
      repoPath: o.repoPath,
      issuesFile: o.issuesFile,
      fixture: o.fixture,
      provider: o.provider,
      model: o.model,
      runsDir: o.runsDir,
      log: (line) => console.log(chalk.dim("· ") + line),
      onTurn: printTurn,
    });

    console.log("");
    if (o.dryRun && result.diff) {
      console.log(chalk.bold("diff (dry run):"));
      console.log(result.diff);
    }
    const ok = result.outcome === "submitted";
    console.log(chalk.bold(ok ? chalk.green(`✔ ${result.outcome}`) : chalk.red(`✖ ${result.outcome}`)) + chalk.dim(`  ${result.detail}`));
    console.log(
      chalk.dim(
        `  steps ${result.steps} · ${formatUsd(result.totals.costUsd)} · in ${result.totals.inputTokens.toLocaleString()} · cache ${result.totals.cacheReadTokens.toLocaleString()} · out ${result.totals.outputTokens.toLocaleString()} · ${(result.durationMs / 1000).toFixed(0)}s`,
      ),
    );
    if (result.baseline) console.log(chalk.dim(`  baseline ${result.baseline.passed} passed / ${result.baseline.failed} failed`) + (result.after ? chalk.dim(` → after ${result.after.passed} passed / ${result.after.failed} failed`) : ""));
    if (result.changedFiles.length) console.log(chalk.dim(`  files: ${result.changedFiles.join(", ")}`));
    if (result.pr) console.log(chalk.bold.green(`  PR: ${result.pr.url}`));
    else if (result.prFile) console.log(chalk.yellow(`  PR body: ${result.prFile}`));
    console.log(chalk.dim(`  trajectory: ${result.runDir}/trajectory.html`));
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("build-image")
  .description("build the sandbox image from sandbox/Dockerfile")
  .option("--tag <tag>", "image tag", DEFAULT_IMAGE)
  .option("--force", "rebuild even if the image exists", false)
  .action(async (o) => {
    await ensureSandboxImage({ tag: o.tag, force: o.force, log: (m) => console.log(chalk.dim("· ") + m) });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
