/**
 * Parses `https://github.com/owner/repo/issues/N` (with optional trailing
 * slash, query string, fragment or `.git`) and the short form `owner/repo#N`.
 */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

const NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const URL_RE = new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${NAME})/issues/(\\d+)/?(?:[?#].*)?$`, "i");
const SHORT_RE = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);

export function parseIssueRef(input: string): IssueRef {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("empty issue reference");
  const m = URL_RE.exec(trimmed) ?? SHORT_RE.exec(trimmed);
  if (!m) {
    throw new Error(
      `cannot parse issue reference "${input}". Expected https://github.com/owner/repo/issues/N or owner/repo#N`,
    );
  }
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/i, "");
  const number = Number(m[3]);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`invalid issue number in "${input}"`);
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/issues/${number}` };
}

/** Branch-safe slug from an issue title: lower-case, dashes, max 40 chars. */
export function slugify(title: string, max = 40): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "fix";
}
