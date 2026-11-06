/**
 * Host-side git: clone the repository for the sandbox, apply the patch the
 * sandbox produced, create the fix branch, commit, push. The default branch
 * is never pushed to; pushes go to `fix/issue-<N>-<slug>` only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Sandbox } from "../sandbox/types.js";
import { slugify, type IssueRef } from "./issueRef.js";

export interface CloneOptions {
  /** https clone URL or a local directory. */
  source: string;
  dest: string;
  branch?: string | undefined;
}

export async function cloneRepository(opts: CloneOptions): Promise<SimpleGit> {
  await fs.mkdir(path.dirname(opts.dest), { recursive: true });
  const git = simpleGit();
  // Line endings must survive the host -> sandbox -> patch round trip
  // byte for byte, so autocrlf is off from the very first checkout.
  const args = ["--no-tags", "--config", "core.autocrlf=false"];
  if (opts.branch) args.push("--branch", opts.branch);
  await git.clone(opts.source, opts.dest, args);
  const repo = simpleGit(opts.dest);
  await repo.addConfig("user.name", "autofix-agent");
  await repo.addConfig("user.email", "autofix-agent@users.noreply.github.com");
  await repo.addConfig("core.autocrlf", "false");
  return repo;
}

/** Directories never copied into a local source snapshot. */
const SNAPSHOT_EXCLUDES = new Set(["node_modules", ".git", "dist", "coverage", ".venv", "__pycache__", "runs"]);

async function copyTree(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (SNAPSHOT_EXCLUDES.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

/**
 * `--repo-path` may point at a plain directory (for example demo-repo inside
 * this repository). Git can only clone a repository, so snapshot such a
 * directory into `<runDir>/source` with one baseline commit on `main`.
 */
export async function prepareLocalSource(repoPath: string, runDir: string): Promise<string> {
  const abs = path.resolve(repoPath);
  try {
    await fs.access(path.join(abs, ".git"));
    return abs;
  } catch {
    /* not a git repository: snapshot it */
  }
  const dest = path.join(runDir, "source");
  await copyTree(abs, dest);
  const git = simpleGit(dest);
  await git.init(["-b", "main"]);
  await git.addConfig("user.name", "autofix-agent");
  await git.addConfig("user.email", "autofix-agent@users.noreply.github.com");
  await git.addConfig("core.autocrlf", "false");
  await git.add(["-A"]);
  await git.commit("baseline snapshot of local source");
  return dest;
}

export async function headSha(repoDir: string): Promise<string> {
  return (await simpleGit(repoDir).revparse(["HEAD"])).trim();
}

export async function currentBranch(repoDir: string): Promise<string> {
  const out = (await simpleGit(repoDir).revparse(["--abbrev-ref", "HEAD"])).trim();
  return out;
}

/** Exclusions for the patch: build output and dependency folders that may not be git-ignored. */
const PATCH_EXCLUDES = ["node_modules", ".venv", "__pycache__", "dist", "build", ".pytest_cache", ".mypy_cache", ".ruff_cache", "coverage"];

/**
 * Produce a patch for everything the agent changed, including new files, by
 * staging inside the sandbox and diffing against HEAD.
 */
export async function exportPatch(sandbox: Sandbox): Promise<{ patch: string; files: string[] }> {
  // Stage everything (.gitignore is respected), then keep dependency and
  // build folders out of the patch even in repositories that forgot to
  // ignore them.
  const excludes = PATCH_EXCLUDES.map((e) => `':(exclude)${e}' ':(exclude,glob)**/${e}/**'`).join(" ");
  const add = await sandbox.exec("git add -A", { timeoutMs: 120_000 });
  if (add.exitCode !== 0) throw new Error(`git add failed in sandbox: ${add.stderr}`);
  const diff = await sandbox.exec(`git diff --cached --binary --no-color HEAD -- . ${excludes}`, { timeoutMs: 120_000 });
  if (diff.exitCode !== 0) throw new Error(`git diff failed in sandbox: ${diff.stderr}`);
  const names = await sandbox.exec(`git diff --cached --name-only HEAD -- . ${excludes}`, { timeoutMs: 60_000 });
  const files = names.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const patch = diff.stdout;
  if (patch.length > 2 * 1024 * 1024) throw new Error(`patch is ${(patch.length / 1024 / 1024).toFixed(1)} MB; refusing to publish`);
  return { patch, files };
}

export async function applyPatch(repoDir: string, patch: string): Promise<void> {
  const file = path.join(path.dirname(repoDir), "fix.patch");
  await fs.writeFile(file, patch, "utf8");
  const git = simpleGit(repoDir);
  await git.raw(["apply", "--index", "--whitespace=nowarn", file]);
}

export function branchNameFor(issue: IssueRef, title: string): string {
  return `fix/issue-${issue.number}-${slugify(title)}`;
}

export interface PublishOptions {
  repoDir: string;
  branch: string;
  baseBranch: string;
  commitMessage: string;
  /** `AUTHORIZATION: basic ...` header for the push; null means do not push. */
  authHeader: string | null;
  remoteUrl: string;
}

export interface PublishResult {
  pushed: boolean;
  commitSha: string;
  error?: string | undefined;
}

export async function commitAndPush(opts: PublishOptions): Promise<PublishResult> {
  const git = simpleGit(opts.repoDir);
  if (opts.branch === opts.baseBranch || /^(main|master)$/.test(opts.branch)) {
    throw new Error(`refusing to commit to ${opts.branch}; fixes go to a fix/ branch`);
  }
  await git.checkoutLocalBranch(opts.branch);
  await git.add(["-A"]);
  await git.commit(opts.commitMessage);
  const commitSha = (await git.revparse(["HEAD"])).trim();
  if (!opts.authHeader) return { pushed: false, commitSha, error: "no GitHub token available for push" };
  try {
    // The token travels in a one-off header, never into .git/config.
    await git.raw(["-c", `http.extraheader=${opts.authHeader}`, "push", "--set-upstream", opts.remoteUrl, `${opts.branch}:${opts.branch}`]);
    return { pushed: true, commitSha };
  } catch (err) {
    return { pushed: false, commitSha, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function diffStat(repoDir: string): Promise<string> {
  return (await simpleGit(repoDir).diff(["--cached", "--stat"])).trim();
}

export async function stagedDiff(repoDir: string): Promise<string> {
  return simpleGit(repoDir).diff(["--cached", "--no-color"]);
}
