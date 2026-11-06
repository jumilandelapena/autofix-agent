/**
 * GitHub access. `OctokitGitHub` talks to the real API with GITHUB_TOKEN.
 * `LocalGitHub` reads issues from an issues.json file and writes pr.md
 * instead of opening a pull request, so the pipeline can run offline.
 */
import fs from "node:fs";
import path from "node:path";
import { Octokit } from "octokit";
import type { IssueRef } from "./issueRef.js";
import type { GitHubApi, IssueData, PullRequestResult } from "./types.js";

export class OctokitGitHub implements GitHubApi {
  readonly kind = "octokit" as const;
  private readonly octokit: Octokit;

  constructor(private readonly token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  static fromEnv(): OctokitGitHub | null {
    const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
    return token ? new OctokitGitHub(token) : null;
  }

  async fetchIssue(ref: IssueRef): Promise<IssueData> {
    const { owner, repo, number } = ref;
    const [{ data: issue }, { data: repository }, comments] = await Promise.all([
      this.octokit.rest.issues.get({ owner, repo, issue_number: number }),
      this.octokit.rest.repos.get({ owner, repo }),
      this.octokit.paginate(this.octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
    ]);
    if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
    return {
      ref,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
      comments: comments.map((c) => ({ author: c.user?.login ?? "unknown", body: c.body ?? "", createdAt: c.created_at })),
      cloneUrl: repository.clone_url,
      defaultBranch: repository.default_branch,
      htmlUrl: issue.html_url,
    };
  }

  async commentOnIssue(ref: IssueRef, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ owner: ref.owner, repo: ref.repo, issue_number: ref.number, body });
  }

  async branchExists(ref: IssueRef, branch: string): Promise<boolean> {
    try {
      await this.octokit.rest.repos.getBranch({ owner: ref.owner, repo: ref.repo, branch });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return false;
      throw err;
    }
  }

  private async ensureLabel(ref: IssueRef, name: string): Promise<void> {
    try {
      await this.octokit.rest.issues.getLabel({ owner: ref.owner, repo: ref.repo, name });
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      await this.octokit.rest.issues.createLabel({
        owner: ref.owner,
        repo: ref.repo,
        name,
        color: "7057ff",
        description: "Opened by autofix-agent; needs human review",
      });
    }
  }

  async createPullRequest(args: {
    ref: IssueRef;
    head: string;
    base: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<PullRequestResult> {
    const { owner, repo } = args.ref;
    const { data: pr } = await this.octokit.rest.pulls.create({
      owner,
      repo,
      head: args.head,
      base: args.base,
      title: args.title,
      body: args.body,
      maintainer_can_modify: true,
    });
    for (const label of args.labels) await this.ensureLabel(args.ref, label);
    if (args.labels.length) {
      await this.octokit.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: args.labels });
    }
    return { url: pr.html_url, number: pr.number, branch: args.head };
  }

  pushAuthHeader(): string {
    const basic = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    return `AUTHORIZATION: basic ${basic}`;
  }
}

export interface LocalIssue {
  number: number;
  title: string;
  body: string;
  labels?: string[];
  comments?: Array<{ author: string; body: string; createdAt?: string }>;
}

/** Offline GitHub: issues come from a JSON file, the PR body is written to disk. */
export class LocalGitHub implements GitHubApi {
  readonly kind = "local" as const;
  readonly comments: Array<{ ref: IssueRef; body: string }> = [];
  readonly pullRequests: Array<{ ref: IssueRef; head: string; title: string; body: string; file: string }> = [];

  constructor(
    private readonly issuesFile: string,
    private readonly repoPath: string,
    private readonly outputDir: string,
    private readonly defaultBranch = "main",
  ) {}

  private loadIssues(): LocalIssue[] {
    const raw = JSON.parse(fs.readFileSync(this.issuesFile, "utf8")) as { issues?: LocalIssue[] } | LocalIssue[];
    return Array.isArray(raw) ? raw : (raw.issues ?? []);
  }

  async fetchIssue(ref: IssueRef): Promise<IssueData> {
    const issue = this.loadIssues().find((i) => i.number === ref.number);
    if (!issue) throw new Error(`issue #${ref.number} not found in ${this.issuesFile}`);
    return {
      ref,
      title: issue.title,
      body: issue.body,
      labels: issue.labels ?? [],
      comments: (issue.comments ?? []).map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt ?? "" })),
      cloneUrl: path.resolve(this.repoPath),
      defaultBranch: this.defaultBranch,
      htmlUrl: ref.url,
    };
  }

  async commentOnIssue(ref: IssueRef, body: string): Promise<void> {
    this.comments.push({ ref, body });
    fs.mkdirSync(this.outputDir, { recursive: true });
    fs.writeFileSync(path.join(this.outputDir, "issue-comment.md"), body);
  }

  async branchExists(): Promise<boolean> {
    return false;
  }

  async createPullRequest(args: { ref: IssueRef; head: string; base: string; title: string; body: string }): Promise<PullRequestResult> {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const file = path.join(this.outputDir, "pr.md");
    fs.writeFileSync(file, `# ${args.title}\n\nbranch: ${args.head} -> ${args.base}\n\n${args.body}`);
    this.pullRequests.push({ ref: args.ref, head: args.head, title: args.title, body: args.body, file });
    return { url: `file://${file.replace(/\\/g, "/")}`, number: 0, branch: args.head };
  }

  pushAuthHeader(): null {
    return null;
  }
}
