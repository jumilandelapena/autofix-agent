import { describe, expect, it } from "vitest";
import { parseIssueRef, slugify } from "../src/github/issueRef.js";

describe("parseIssueRef", () => {
  it("parses a full GitHub URL", () => {
    expect(parseIssueRef("https://github.com/octo-org/my.repo/issues/42")).toEqual({
      owner: "octo-org",
      repo: "my.repo",
      number: 42,
      url: "https://github.com/octo-org/my.repo/issues/42",
    });
  });

  it("tolerates trailing slash, query, fragment, http and www", () => {
    expect(parseIssueRef("http://www.github.com/a/b/issues/7/?tab=x#top").number).toBe(7);
    expect(parseIssueRef("  https://github.com/a/b/issues/7  ").repo).toBe("b");
  });

  it("parses the short form owner/repo#N", () => {
    expect(parseIssueRef("jumilandelapena/demo-inventory-api#3")).toMatchObject({
      owner: "jumilandelapena",
      repo: "demo-inventory-api",
      number: 3,
    });
  });

  it("rejects bad input", () => {
    for (const bad of ["", "github.com/a/b", "https://github.com/a/b/pull/3", "a/b#0", "a/b#x", "https://gitlab.com/a/b/issues/1", "a//b#1"]) {
      expect(() => parseIssueRef(bad), bad).toThrow();
    }
  });
});

describe("slugify", () => {
  it("builds a branch-safe slug", () => {
    expect(slugify("GET /items?limit=N returns N+1 items")).toBe("get-items-limit-n-returns-n-1-items");
    expect(slugify("Söme Ünïcode!!")).toBe("some-unicode");
    expect(slugify("---")).toBe("fix");
  });

  it("caps the length without a trailing dash", () => {
    const slug = slugify("a".repeat(30) + " " + "b".repeat(30));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});
