import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeTool, initialState, type ToolContext } from "../src/agent/tools.js";
import { LocalSandbox } from "../src/sandbox/local.js";
import { DEFAULT_LIMITS } from "../src/sandbox/types.js";
import { TrajectoryLogger } from "../src/trajectory/logger.js";

let dir: string;
let ctx: ToolContext;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autofix-edit-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src/a.ts"), "const x = 1;\nconst y = 2;\nconst x2 = 1;\nexport const z = x + y;\n");
  const sandbox = await LocalSandbox.create({ repoDir: dir, limits: DEFAULT_LIMITS });
  ctx = {
    sandbox,
    project: { kind: "node", framework: "vitest", packageManager: "npm", installCommand: null, testCommand: null, lintCommand: null, facts: [] },
    baseline: { tests: { framework: "vitest", passed: 0, failed: 0, skipped: 0, total: 0, failedTests: [], parsed: true }, testOutput: "", lint: null, testFiles: new Set(["tests/existing.test.ts"]) },
    state: initialState(),
    trajectory: new TrajectoryLogger(path.join(dir, "run")),
    log: () => {},
  };
});

afterAll(async () => {
  ctx.trajectory.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("edit_file", () => {
  it("rejects old_text that is not found", async () => {
    const res = await executeTool("edit_file", { path: "src/a.ts", old_text: "nope", new_text: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not found/);
  });

  it("rejects old_text that matches more than once", async () => {
    const res = await executeTool("edit_file", { path: "src/a.ts", old_text: "const x", new_text: "let x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/occurs 2 times/);
    expect(await fs.readFile(path.join(dir, "src/a.ts"), "utf8")).toContain("const x = 1;");
  });

  it("replaces exactly one occurrence and reports a diff", async () => {
    const res = await executeTool("edit_file", { path: "src/a.ts", old_text: "const y = 2;", new_text: "const y = 3;" }, ctx);
    expect(res.isError).toBe(false);
    expect(res.content).toContain("- const y = 2;");
    expect(res.content).toContain("+ const y = 3;");
    expect(await fs.readFile(path.join(dir, "src/a.ts"), "utf8")).toContain("const y = 3;");
    expect(ctx.state.writtenFiles.has("src/a.ts")).toBe(true);
  });

  it("fails cleanly for a missing file and for escaping paths", async () => {
    expect((await executeTool("edit_file", { path: "src/missing.ts", old_text: "a", new_text: "b" }, ctx)).isError).toBe(true);
    const escape = await executeTool("edit_file", { path: "../outside.ts", old_text: "a", new_text: "b" }, ctx);
    expect(escape.isError).toBe(true);
    expect(escape.content).toMatch(/escapes the workspace/);
  });

  it("rejects invalid input instead of throwing", async () => {
    const res = await executeTool("edit_file", { path: "src/a.ts" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invalid input/);
  });
});

describe("write_file and read_file", () => {
  it("creates files with parent directories and reads line ranges", async () => {
    const w = await executeTool("write_file", { path: "tests/new/thing.test.ts", content: "l1\nl2\nl3\nl4\n" }, ctx);
    expect(w.isError).toBe(false);
    expect(w.content).toMatch(/created tests\/new\/thing\.test\.ts/);
    const r = await executeTool("read_file", { path: "tests/new/thing.test.ts", start_line: 2, end_line: 3 }, ctx);
    expect(r.content).toBe("tests/new/thing.test.ts (lines 2-3 of 5)\nl2\nl3");
  });

  it("refuses to overwrite a pre-existing test file", async () => {
    const res = await executeTool("write_file", { path: "tests/existing.test.ts", content: "" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/existing test file/);
  });
});

describe("bash", () => {
  it("runs commands, reports exit codes and denies dangerous ones", async () => {
    const ok = await executeTool("bash", { command: "echo hi && exit 3" }, ctx);
    expect(ok.isError).toBe(false);
    expect(ok.content).toMatch(/exit code: 3/);
    expect(ok.content).toContain("hi");
    const denied = await executeTool("bash", { command: "curl http://example.com" }, ctx);
    expect(denied.isError).toBe(true);
    expect(denied.content).toMatch(/denied/);
  });

  it("enforces the per-command timeout", async () => {
    const res = await executeTool("bash", { command: "sleep 30", timeout_s: 1 }, ctx);
    expect(res.content).toMatch(/exit code: 124 \(timed out\)/);
  });
});
