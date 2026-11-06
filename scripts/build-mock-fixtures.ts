/**
 * Builds evals/fixtures/mock/issue-<N>.json: the assistant turns the mock
 * provider replays for each planted bug in demo-repo.
 *
 * These fixtures were authored by hand in the same shape the real provider
 * records (`api_response.content` + `stop_reason`), because the build
 * session had no API key. After a real run, `pnpm fixture:from-run
 * runs/<id>/trajectory.jsonl` regenerates a fixture from a genuine trajectory.
 * Tool results are NOT in the fixture: every tool call is executed for real
 * against the sandbox, so a fixture only "works" if the edits apply and the
 * tests really fail before and pass after.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface Turn {
  content: Block[];
  stop_reason: "tool_use" | "end_turn";
}

interface Step {
  text?: string;
  tool: string;
  input: Record<string, unknown>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../evals/fixtures/mock");

function build(issue: number, description: string, steps: Step[]): void {
  const turns: Turn[] = steps.map((s, k) => ({
    content: [
      ...(s.text ? [{ type: "text" as const, text: s.text }] : []),
      { type: "tool_use" as const, id: `toolu_mock_${issue}_${k + 1}`, name: s.tool, input: s.input },
    ],
    stop_reason: "tool_use" as const,
  }));
  const fixture = {
    issue,
    repo: "demo-inventory-api",
    description,
    model: "claude-opus-5-5 (mock replay)",
    recorded: "hand-authored replay in the api_response shape; regenerate from a real run with scripts/fixture-from-run.ts",
    turns,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `issue-${issue}.json`), JSON.stringify(fixture, null, 2) + "\n");
}

const runOne = (file: string) => ({ tool: "run_tests", input: { command: `npx vitest run ${file}` } });
const runAll = { tool: "run_tests", input: {} };

// ---------------------------------------------------------------- issue 1
build(1, "paginate() slices one item too many", [
  { text: "The issue is about the limit on GET /items. Let me find where pagination happens.", tool: "search", input: { pattern: "paginate|limit", glob: "src/**/*.ts" } },
  { tool: "read_file", input: { path: "src/utils.ts" } },
  {
    text: "paginate() uses `offset + limit + 1` as the slice end, so every page has one extra item. First a failing test.",
    tool: "write_file",
    input: {
      path: "tests/issue-1-pagination.test.ts",
      content: `import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { paginate } from "../src/utils.js";

describe("issue #1: limit returns N+1 items", () => {
  it("paginate returns at most limit items", () => {
    expect(paginate([1, 2, 3, 4, 5], 0, 2)).toEqual([1, 2]);
    expect(paginate([1, 2, 3, 4, 5], 2, 2)).toEqual([3, 4]);
    expect(paginate([1, 2, 3, 4, 5], 4, 2)).toEqual([5]);
  });

  it("GET /items?limit=2 returns exactly 2 items", async () => {
    const res = await request(createApp()).get("/items").query({ limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([1, 2]);
  });

  it("pages do not overlap when offset advances by limit", async () => {
    const app = createApp();
    const first = await request(app).get("/items").query({ limit: 2, offset: 0 });
    const second = await request(app).get("/items").query({ limit: 2, offset: 2 });
    expect(second.body.items[0].id).not.toBe(first.body.items[first.body.items.length - 1].id);
  });
});
`,
    },
  },
  runOne("tests/issue-1-pagination.test.ts"),
  {
    text: "Reproduced: 3 items for limit=2. The fix is the slice end.",
    tool: "edit_file",
    input: {
      path: "src/utils.ts",
      old_text: "  return items.slice(offset, offset + limit + 1);",
      new_text: "  return items.slice(offset, offset + limit);",
    },
  },
  runAll,
  {
    tool: "submit",
    input: {
      summary: "`paginate()` in src/utils.ts sliced to `offset + limit + 1`, so every page carried one extra item and pages overlapped when clients advanced `offset` by `limit`. The slice end is now `offset + limit`. Added tests/issue-1-pagination.test.ts covering the helper and the `/items?limit=` endpoint.",
      root_cause: "Off-by-one in the slice end index of paginate(): Array.prototype.slice's end is exclusive, so adding 1 returned limit+1 items.",
      test_file: "tests/issue-1-pagination.test.ts",
    },
  },
]);

// ---------------------------------------------------------------- issue 2
build(2, "applyDiscount() subtracts percent as an absolute amount", [
  { text: "Let me look at how the discount is applied.", tool: "search", input: { pattern: "applyDiscount", glob: "src/**/*.ts" } },
  { tool: "read_file", input: { path: "src/utils.ts", start_line: 1, end_line: 20 } },
  {
    text: "applyDiscount() does `price - percent`, treating the percentage as dollars. Writing the failing test first.",
    tool: "write_file",
    input: {
      path: "tests/issue-2-discount.test.ts",
      content: `import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applyDiscount } from "../src/utils.js";

describe("issue #2: discount is a percentage, not a dollar amount", () => {
  it("applies 10% to 399 -> 359.1", () => {
    expect(applyDiscount(399, 10)).toBe(359.1);
    expect(applyDiscount(100, 25)).toBe(75);
    expect(applyDiscount(4.5, 100)).toBe(0);
  });

  it("GET /items/2/price?discount=10 returns 359.1", async () => {
    const res = await request(createApp()).get("/items/2/price").query({ discount: 10 });
    expect(res.status).toBe(200);
    expect(res.body.price).toBe(359.1);
    expect(res.body.formatted).toBe("$359.10");
  });
});
`,
    },
  },
  runOne("tests/issue-2-discount.test.ts"),
  {
    text: "Reproduced (389 instead of 359.1). Use the percentage.",
    tool: "edit_file",
    input: {
      path: "src/utils.ts",
      old_text: "  return round2(price - percent);",
      new_text: "  return round2(price * (1 - percent / 100));",
    },
  },
  runAll,
  {
    tool: "submit",
    input: {
      summary: "`applyDiscount()` subtracted the percentage from the price as if it were a dollar amount (399 - 10 = 389). It now multiplies by `(1 - percent / 100)` and rounds to cents, so 10% off 399 is 359.10. Added tests/issue-2-discount.test.ts for the helper and the `/items/:id/price` endpoint.",
      root_cause: "Wrong formula in applyDiscount(): `price - percent` instead of `price * (1 - percent / 100)`.",
      test_file: "tests/issue-2-discount.test.ts",
    },
  },
]);

// ---------------------------------------------------------------- issue 3
build(3, "ItemStore.update() builds the updated item but never stores it", [
  { text: "PUT returns the new values but GET shows old ones, so the store probably does not persist. Reading the store.", tool: "read_file", input: { path: "src/store.ts" } },
  { tool: "search", input: { pattern: "store\\.update|app\\.put", glob: "src/**/*.ts" } },
  {
    text: "update() computes `updated` and returns it without writing it back into `this.items`. Failing test first.",
    tool: "write_file",
    input: {
      path: "tests/issue-3-update-persists.test.ts",
      content: `import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ItemStore } from "../src/store.js";

describe("issue #3: PUT /items/:id persists the update", () => {
  it("store.update changes what get() returns afterwards", () => {
    const store = new ItemStore();
    const updated = store.update(3, { quantity: 5 });
    expect(updated?.quantity).toBe(5);
    expect(store.get(3)?.quantity).toBe(5);
  });

  it("GET after PUT returns the updated fields and slug", async () => {
    const app = createApp();
    const put = await request(app).put("/items/3").send({ name: "Dotted Notebook", quantity: 5 });
    expect(put.status).toBe(200);
    const get = await request(app).get("/items/3");
    expect(get.status).toBe(200);
    expect(get.body.quantity).toBe(5);
    expect(get.body.name).toBe("Dotted Notebook");
    expect(get.body.slug).toBe("dotted-notebook");
  });
});
`,
    },
  },
  runOne("tests/issue-3-update-persists.test.ts"),
  {
    text: "Reproduced. Store the updated item in place.",
    tool: "edit_file",
    input: {
      path: "src/store.ts",
      old_text: `      tags: patch.tags ?? item.tags,
    };
    return updated;`,
      new_text: `      tags: patch.tags ?? item.tags,
    };
    this.items[this.items.indexOf(item)] = updated;
    return updated;`,
    },
  },
  runAll,
  {
    tool: "submit",
    input: {
      summary: "`ItemStore.update()` built the merged item and returned it, but never wrote it back into the array, so the PUT response and later reads disagreed. The updated item now replaces the old one in place. Added tests/issue-3-update-persists.test.ts covering the store and a PUT-then-GET round trip, including the recomputed slug.",
      root_cause: "update() returned a new object without replacing the stored one; the array still held the original item.",
      test_file: "tests/issue-3-update-persists.test.ts",
    },
  },
]);

// ---------------------------------------------------------------- issue 4
build(4, "ItemStore.search() is case-sensitive", [
  { text: "Checking how search is implemented.", tool: "search", input: { pattern: "search\\(", glob: "src/**/*.ts" } },
  { tool: "read_file", input: { path: "src/store.ts", start_line: 30, end_line: 45 } },
  {
    text: "search() uses `name.includes(query)` with no case folding, although the docstring says case-insensitive. Failing test first.",
    tool: "write_file",
    input: {
      path: "tests/issue-4-search-case.test.ts",
      content: `import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ItemStore } from "../src/store.js";

describe("issue #4: search is case-insensitive", () => {
  it("store.search ignores case", () => {
    const store = new ItemStore();
    const names = (q: string) => store.search(q).map((i) => i.name);
    expect(names("desk")).toEqual(["Desk Lamp", "Standing Desk"]);
    expect(names("DESK")).toEqual(["Desk Lamp", "Standing Desk"]);
    expect(names("Desk")).toEqual(["Desk Lamp", "Standing Desk"]);
  });

  it("GET /items?q=desk returns both desks", async () => {
    const res = await request(createApp()).get("/items").query({ q: "desk" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(["Desk Lamp", "Standing Desk"]);
  });
});
`,
    },
  },
  runOne("tests/issue-4-search-case.test.ts"),
  {
    text: "Reproduced. Compare lower-cased strings.",
    tool: "edit_file",
    input: {
      path: "src/store.ts",
      old_text: "    return this.items.filter((item) => item.name.includes(query));",
      new_text: `    const needle = query.toLowerCase();
    return this.items.filter((item) => item.name.toLowerCase().includes(needle));`,
    },
  },
  runAll,
  {
    tool: "submit",
    input: {
      summary: "`ItemStore.search()` compared the raw query against the raw name, so `desk` did not match `Desk Lamp` even though the API is documented as case-insensitive. Both sides are now lower-cased before the substring check. Added tests/issue-4-search-case.test.ts for the store and the `/items?q=` endpoint.",
      root_cause: "search() used String.prototype.includes without normalising case on either side.",
      test_file: "tests/issue-4-search-case.test.ts",
    },
  },
]);

// ---------------------------------------------------------------- issue 5
build(5, "ItemStore.remove() splices index -1 when the id is unknown", [
  { text: "A DELETE of an unknown id removes another item; that smells like an unchecked findIndex. Reading the store.", tool: "read_file", input: { path: "src/store.ts", start_line: 60, end_line: 75 } },
  { tool: "search", input: { pattern: "store\\.remove|app\\.delete", glob: "src/**/*.ts" } },
  {
    text: "remove() calls splice(index, 1) even when findIndex returned -1, which deletes the last element. Failing test first.",
    tool: "write_file",
    input: {
      path: "tests/issue-5-delete-unknown.test.ts",
      content: `import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ItemStore } from "../src/store.js";

describe("issue #5: deleting an unknown id must not remove anything", () => {
  it("store.remove returns false and keeps every item", () => {
    const store = new ItemStore();
    expect(store.remove(999)).toBe(false);
    expect(store.list()).toHaveLength(5);
    expect(store.get(5)?.name).toBe("USB-C Cable");
  });

  it("DELETE /items/999 returns 404 and the store is unchanged", async () => {
    const app = createApp();
    const del = await request(app).delete("/items/999");
    expect(del.status).toBe(404);
    const list = await request(app).get("/items");
    expect(list.body.total).toBe(5);
  });
});
`,
    },
  },
  runOne("tests/issue-5-delete-unknown.test.ts"),
  {
    text: "Reproduced: 204 and the last item disappears. Guard the index.",
    tool: "edit_file",
    input: {
      path: "src/store.ts",
      old_text: `    const index = this.items.findIndex((item) => item.id === id);
    this.items.splice(index, 1);
    return true;`,
      new_text: `    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;`,
    },
  },
  runAll,
  {
    tool: "submit",
    input: {
      summary: "`ItemStore.remove()` spliced at whatever `findIndex` returned, so an unknown id gave `splice(-1, 1)` and silently deleted the last item while reporting success. It now returns `false` without touching the array when the id is not found, which makes the route answer 404. Added tests/issue-5-delete-unknown.test.ts for the store and the DELETE endpoint.",
      root_cause: "Unchecked findIndex() result: splice(-1, 1) removes the last element instead of nothing.",
      test_file: "tests/issue-5-delete-unknown.test.ts",
    },
  },
]);

// ---------------------------------------------------------------- issue 6
build(6, "slugify() does not trim leading/trailing hyphens", [
  { text: "Let me read slugify.", tool: "read_file", input: { path: "src/utils.ts", start_line: 1, end_line: 12 } },
  {
    text: "slugify() replaces runs of non-alphanumerics with '-' but never strips the ends. Failing test first.",
    tool: "write_file",
    input: {
      path: "tests/issue-6-slugify-trim.test.ts",
      content: `import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { slugify } from "../src/utils.js";

describe("issue #6: slugify trims leading and trailing hyphens", () => {
  it("strips hyphens at both ends", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  Spaced  ")).toBe("spaced");
    expect(slugify("Mr. Coffee")).toBe("mr-coffee");
  });

  it("keeps interior hyphens", () => {
    expect(slugify("USB-C Cable")).toBe("usb-c-cable");
  });

  it("POST /items produces a clean slug", async () => {
    const res = await request(createApp()).post("/items").send({ name: "Hello World!", price: 1, quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("hello-world");
  });
});
`,
    },
  },
  runOne("tests/issue-6-slugify-trim.test.ts"),
  {
    text: "Reproduced ('hello-world-'). Trim the ends.",
    tool: "edit_file",
    input: {
      path: "src/utils.ts",
      old_text: `  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");`,
      new_text: `  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");`,
    },
  },
  runAll,
  {
    tool: "submit",
    input: {
      summary: "`slugify()` collapsed non-alphanumeric runs into hyphens but left the hyphens produced at the start or end of the string, giving `hello-world-` for `Hello World!`. A final `.replace(/^-+|-+$/g, \"\")` strips them; interior hyphens are untouched. Added tests/issue-6-slugify-trim.test.ts including the POST /items path.",
      root_cause: "Missing trim of leading/trailing separator characters after the replace step in slugify().",
      test_file: "tests/issue-6-slugify-trim.test.ts",
    },
  },
]);

console.log(`wrote 6 fixtures to ${outDir}`);
