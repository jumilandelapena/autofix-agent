/**
 * Sandbox abstraction. The agent only ever talks to this interface, so the
 * same tools and loop run against a Docker container (production) or a
 * throwaway directory on the host (`--sandbox local`, used for fast tests).
 */

export interface ExecOptions {
  /** Per-command timeout. Default 120 s, hard cap 600 s. */
  timeoutMs?: number;
  /** Working directory inside the sandbox. Defaults to the workspace root. */
  cwd?: string;
  /** Extra environment variables for this command only. */
  env?: Record<string, string>;
  /** Run as root (Docker only). Used once for `chown` after copying the repo in. */
  asRoot?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  command: string;
}

export interface SandboxLimits {
  cpus: number;
  memoryBytes: number;
  wallClockMs: number;
  pidsLimit: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  cpus: 2,
  memoryBytes: 4 * 1024 * 1024 * 1024,
  wallClockMs: 30 * 60 * 1000,
  pidsLimit: 512,
};

export const WORKSPACE = "/workspace";

export interface Sandbox {
  readonly kind: "docker" | "local";
  /** Absolute path of the repository root as the agent sees it (always "/workspace"). */
  readonly workspace: string;
  /** Run a shell command (`bash -lc`) inside the sandbox. Never throws for a non-zero exit. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Read a UTF-8 text file. `path` is relative to the workspace or an absolute /workspace path. */
  readFile(path: string): Promise<string>;
  /** Write a UTF-8 text file, creating parent directories. */
  writeFile(path: string, content: string): Promise<void>;
  /** True when the path exists (file or directory). */
  exists(path: string): Promise<boolean>;
  /** Cut the sandbox off from the network for the rest of the run. */
  disconnectNetwork(): Promise<void>;
  /** True once the wall clock expired; every exec after that fails fast. */
  readonly expired: boolean;
  /** Stop and delete the sandbox. Safe to call twice. */
  destroy(): Promise<void>;
}

/** Thrown by the sandbox when the 30-minute wall clock expires. */
export class SandboxExpiredError extends Error {
  constructor() {
    super("sandbox wall clock expired");
    this.name = "SandboxExpiredError";
  }
}

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;

/** Cap captured output so a runaway command cannot exhaust host memory. */
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

/**
 * Normalise a model-supplied path to a workspace-relative POSIX path.
 * Rejects anything that escapes the workspace ("..", absolute paths outside
 * /workspace, home-relative paths).
 */
export function toWorkspaceRelative(input: string): string {
  let p = input.trim().replace(/\\/g, "/");
  if (p === "" || p === ".") return "";
  if (p.startsWith("~")) throw new Error(`path escapes the workspace: ${input}`);
  if (p.startsWith(WORKSPACE + "/")) p = p.slice(WORKSPACE.length + 1);
  else if (p === WORKSPACE) p = "";
  else if (p.startsWith("/")) throw new Error(`absolute path outside the workspace: ${input}`);
  if (p.startsWith("./")) p = p.slice(2);
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) throw new Error(`path escapes the workspace: ${input}`);
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/** Shell-quote a string for bash (single quotes). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(ms, MAX_EXEC_TIMEOUT_MS);
}
