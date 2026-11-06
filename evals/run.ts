/**
 * `pnpm eval`: run the agent on every planted bug in demo-repo and write
 * docs/eval-results.md. Options:
 *
 *   --provider anthropic|mock   (default: LLM_PROVIDER or anthropic)
 *   --sandbox docker|local      (default: docker)
 *   --repo owner/name           GitHub repo that holds the issues and gets the PRs
 *   --repo-path <dir>           clone from a local directory (default: demo-repo when offline)
 *   --issues-file <file>        read issues from JSON instead of GitHub
 *   --only 1,3                  subset of issue numbers
 *   --dry-run                   verify but do not push or open PRs
 *   --max-steps, --budget-usd   forwarded to the agent
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { runFix, type FixResult } from "../src/run.js";
import { printTurn } from "../src/cli/output.js";
import type { SandboxKind } from "../src/sandbox/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(name);

interface IssuesFile {
  issues: Array<{ number: number; title: string }>;
}

async function main(): Promise<void> {
  const provider = (arg("--provider") ?? process.env["LLM_PROVIDER"] ?? "anthropic").toLowerCase();
  const sandbox = (arg("--sandbox") ?? process.env["AUTOFIX_SANDBOX"] ?? "docker") as SandboxKind;
  const repo = arg("--repo") ?? process.env["AUTOFIX_DEMO_REPO"] ?? "jumilandelapena/demo-inventory-api";
  const offline = provider === "mock" || !process.env["GITHUB_TOKEN"] || flag("--issues-file") || flag("--repo-path");
  const issuesFile = arg("--issues-file") ?? (offline ? path.join(root, "demo-repo/issues.json") : undefined);
  const repoPath = arg("--repo-path") ?? (offline ? path.join(root, "demo-repo") : undefined);
  const dryRun = flag("--dry-run");
  const only = arg("--only")?.split(",").map(Number);
  const maxSteps = arg("--max-steps") ? Number(arg("--max-steps")) : undefined;
  const budgetUsd = arg("--budget-usd") ? Number(arg("--budget-usd")) : undefined;

  const issues = (JSON.parse(fs.readFileSync(path.join(root, "demo-repo/issues.json"), "utf8")) as IssuesFile).issues.filter(
    (i) => !only || only.includes(i.number),
  );
  console.log(chalk.bold(`eval: ${issues.length} issues · provider ${provider} · sandbox ${sandbox} · ${dryRun ? "dry run" : "live PRs"} · repo ${offline ? repoPath : repo}`));

  const results: FixResult[] = [];
  const startedAt = new Date();
  for (const issue of issues) {
    console.log(chalk.bold.cyan(`\n=== issue #${issue.number}: ${issue.title}`));
    const result = await runFix({
      issue: `${repo}#${issue.number}`,
      provider,
      sandbox,
      dryRun,
      issuesFile,
      repoPath,
      maxSteps,
      budgetUsd,
      runsDir: path.join(root, "runs"),
      log: (line) => console.log(chalk.dim("· ") + line),
      onTurn: printTurn,
    });
    results.push(result);
    console.log(result.outcome === "submitted" ? chalk.green(`✔ ${result.outcome}`) : chalk.red(`✖ ${result.outcome}: ${result.detail}`));
  }

  const outDir = path.join(root, "evals/out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  const md = renderMarkdown(results, { provider, sandbox, dryRun, startedAt, repo: offline ? "local demo-repo" : repo });
  fs.writeFileSync(path.join(root, "docs/eval-results.md"), md);
  console.log(`\nwrote docs/eval-results.md`);
  const failed = results.filter((r) => r.outcome !== "submitted").length;
  process.exitCode = failed ? 1 : 0;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

export function renderMarkdown(
  results: FixResult[],
  meta: { provider: string; sandbox: string; dryRun: boolean; startedAt: Date; repo: string },
): string {
  const yes = (b: boolean) => (b ? "yes" : "no");
  const rows = results.map((r) => {
    const pr = r.pr?.url?.startsWith("http") ? `[#${r.pr.number}](${r.pr.url})` : r.pr ? "pr.md" : "-";
    return `| ${r.issue.number} | ${r.title} | ${yes(r.reproduced)} | ${yes(r.fixed)} | ${yes(r.suiteGreen)} | ${r.steps} | ${(r.durationMs / 1000).toFixed(0)}s | $${r.totals.costUsd.toFixed(4)} | ${pr} | ${r.outcome} |`;
  });
  const total = results.length;
  const submitted = results.filter((r) => r.outcome === "submitted").length;
  const cost = results.reduce((s, r) => s + r.totals.costUsd, 0);
  const steps = results.reduce((s, r) => s + r.steps, 0);
  const time = results.reduce((s, r) => s + r.durationMs, 0);
  const model = results[0]?.model ?? "n/a";
  const mockNote =
    meta.provider === "mock"
      ? `\n> **This table was produced with \`LLM_PROVIDER=mock\`.** The model turns are replayed from \`evals/fixtures/mock\`; every tool call, test run and verification step is real, but no tokens were spent, so cost is $0. Re-run \`pnpm eval\` with \`ANTHROPIC_API_KEY\` set to replace it with real numbers.\n`
      : "";
  return `# Eval results

Generated ${meta.startedAt.toISOString()} · commit \`${gitSha()}\` · provider **${meta.provider}** · model \`${model}\` · sandbox **${meta.sandbox}** · ${meta.dryRun ? "dry run (no PRs)" : "live PRs"} · target: ${meta.repo}
${mockNote}
| # | Issue | Reproduced | Fixed | Suite green | Steps | Time | Cost | PR | Outcome |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

**${submitted}/${total} fixed** · ${steps} steps · ${(time / 60000).toFixed(1)} min · $${cost.toFixed(4)} total · $${total ? (cost / total).toFixed(4) : "0"} per issue

Columns: *Reproduced* = the agent wrote a test that failed on the base commit. *Fixed* = the harness accepted the submission (repro test passes, no new failures, no existing test weakened, lint clean). *Steps* = model turns (API calls). Cost is computed from \`usage\` on every turn with the Claude Opus 5.5 price list (cache reads at $0.20/MTok).
`;
}

main().catch((err: unknown) => {
  console.error(chalk.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
