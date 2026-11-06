/**
 * Detects the project type inside the sandbox and derives the install, test
 * and lint commands. Everything is derived from files, never from the model.
 */
import type { Sandbox } from "./types.js";

export type ProjectKind = "node" | "python" | "go" | "unknown";
export type TestFramework = "vitest" | "jest" | "mocha" | "node-test" | "pytest" | "gotest" | "unknown";

export interface ProjectInfo {
  kind: ProjectKind;
  framework: TestFramework;
  packageManager: "npm" | "pnpm" | "yarn" | "uv" | "go" | "none";
  installCommand: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  /** Human-readable facts for the system prompt. */
  facts: string[];
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

async function readJson<T>(sb: Sandbox, p: string): Promise<T | null> {
  try {
    return JSON.parse(await sb.readFile(p)) as T;
  } catch {
    return null;
  }
}

export interface DetectOptions {
  /** `npm ci` wipes node_modules; the local sandbox prefers an incremental install. */
  cleanInstall?: boolean | undefined;
}

export async function detectProject(sb: Sandbox, opts: DetectOptions = {}): Promise<ProjectInfo> {
  const cleanInstall = opts.cleanInstall ?? true;
  const has = (p: string) => sb.exists(p);

  if (await has("package.json")) {
    const pkg = (await readJson<PackageJson>(sb, "package.json")) ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const scripts = pkg.scripts ?? {};
    const facts: string[] = [`Node.js project${pkg.name ? ` "${pkg.name}"` : ""}`];

    let packageManager: ProjectInfo["packageManager"] = "npm";
    let installCommand: string;
    if (await has("pnpm-lock.yaml")) {
      packageManager = "pnpm";
      installCommand = cleanInstall ? "pnpm install --frozen-lockfile" : "pnpm install";
    } else if (await has("yarn.lock")) {
      packageManager = "yarn";
      installCommand = cleanInstall ? "yarn install --frozen-lockfile" : "yarn install";
    } else if ((await has("package-lock.json")) && cleanInstall) {
      installCommand = "npm ci --no-audit --no-fund";
    } else {
      installCommand = "npm install --no-audit --no-fund";
    }
    facts.push(`package manager: ${packageManager} (install: \`${installCommand}\`)`);

    let framework: TestFramework = "unknown";
    let testCommand: string | null = null;
    const run = packageManager === "npm" ? "npm run" : packageManager;
    if ("vitest" in deps) {
      framework = "vitest";
      testCommand = "npx vitest run";
    } else if ("jest" in deps) {
      framework = "jest";
      testCommand = "npx jest --ci";
    } else if ("mocha" in deps) {
      framework = "mocha";
      testCommand = "npx mocha";
    } else if (scripts["test"] && !/no test specified/.test(scripts["test"])) {
      framework = /node --test|node:test/.test(scripts["test"]) ? "node-test" : "unknown";
      testCommand = packageManager === "npm" ? "npm test --silent" : `${packageManager} test`;
    }
    if (testCommand) facts.push(`test framework: ${framework} (run: \`${testCommand}\`)`);
    else facts.push("no test framework detected; write a repro script with node instead");

    const lintCommand = scripts["lint"] ? `${run} lint` : null;
    if (lintCommand) facts.push(`lint: \`${lintCommand}\``);
    if (deps["typescript"]) facts.push("TypeScript is used; keep types strict");

    return { kind: "node", framework, packageManager, installCommand, testCommand, lintCommand, facts };
  }

  if ((await has("pyproject.toml")) || (await has("requirements.txt"))) {
    const facts: string[] = ["Python project"];
    const hasPyproject = await has("pyproject.toml");
    const pyproject = hasPyproject ? await sb.readFile("pyproject.toml").catch(() => "") : "";
    let installCommand: string;
    if (hasPyproject && (await has("uv.lock"))) {
      installCommand = "uv sync --frozen";
    } else if (hasPyproject) {
      installCommand = "uv venv .venv && uv pip install -e . && (uv pip install pytest || true)";
    } else {
      installCommand = "uv venv .venv && uv pip install -r requirements.txt && uv pip install pytest";
    }
    const testCommand = "uv run --no-sync pytest -q";
    facts.push(`install: \`${installCommand}\``, `test framework: pytest (run: \`${testCommand}\`)`);
    const lintCommand = /\[tool\.ruff\]/.test(pyproject) || (await has("ruff.toml")) ? "uv run --no-sync ruff check ." : null;
    if (lintCommand) facts.push(`lint: \`${lintCommand}\``);
    return { kind: "python", framework: "pytest", packageManager: "uv", installCommand, testCommand, lintCommand, facts };
  }

  if (await has("go.mod")) {
    return {
      kind: "go",
      framework: "gotest",
      packageManager: "go",
      installCommand: "go mod download",
      testCommand: "go test ./...",
      lintCommand: "go vet ./...",
      facts: ["Go module", "test framework: go test (run: `go test ./...`)", "lint: `go vet ./...`"],
    };
  }

  return {
    kind: "unknown",
    framework: "unknown",
    packageManager: "none",
    installCommand: null,
    testCommand: null,
    lintCommand: null,
    facts: ["unknown project type: no package.json, pyproject.toml, requirements.txt or go.mod"],
  };
}

/** Extensions and name patterns that identify test files for the "never delete tests" rule. */
export function isTestFile(p: string): boolean {
  const name = p.replace(/\\/g, "/");
  return (
    /(^|\/)(tests?|__tests__|spec|specs)\//.test(name) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /(^|\/)test_[^/]+\.py$/.test(name) ||
    /_test\.py$/.test(name) ||
    /_test\.go$/.test(name) ||
    /(^|\/)conftest\.py$/.test(name)
  );
}
