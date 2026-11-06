import type { IssueRef } from "./issueRef.js";

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueData {
  ref: IssueRef;
  title: string;
  body: string;
  labels: string[];
  comments: IssueComment[];
  /** Clone URL of the repository (https). */
  cloneUrl: string;
  defaultBranch: string;
  htmlUrl: string;
}

export interface PullRequestResult {
  url: string;
  number: number;
  branch: string;
}

/** The subset of GitHub the pipeline needs; implemented by Octokit and by a local mock. */
export interface GitHubApi {
  readonly kind: "octokit" | "local";
  fetchIssue(ref: IssueRef): Promise<IssueData>;
  commentOnIssue(ref: IssueRef, body: string): Promise<void>;
  branchExists(ref: IssueRef, branch: string): Promise<boolean>;
  createPullRequest(args: {
    ref: IssueRef;
    head: string;
    base: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<PullRequestResult>;
  /** Authorization header value for git push, or null when pushing is impossible. */
  pushAuthHeader(): string | null;
}
