/**
 * Local sandbox: runs commands in a directory on the host.
 *
 * This is NOT isolated. It exists so the unit tests, the mock end-to-end
 * test and `--sandbox local` can run on machines without Docker. The real
 * pipeline uses the Docker sandbox (see docker.ts) by default.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clampTimeout,
  MAX_CAPTURE_BYTES,
  SandboxExpiredError,
  toWorkspaceRelative,
  WORKSPACE,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxLimits,
} from "./types.js";

export interface LocalSandboxOptions {
  /** Host directory that becomes the workspace (already cloned). */
  repoDir: string;
  limits: SandboxLimits;
  /** If this directory has a node_modules folder, link it into the workspace so installs are fast. */
  seedNodeModulesFrom?: string | undefined;
  log?: ((msg: string) => void) | undefined;
}

export class LocalSandbox implements Sandbox {
  readonly kind = "local" as const;
  readonly workspace = WORKSPACE;
  expired = false;
  private destroyed = false;
  private networkOff = false;
  private readonly timer: NodeJS.Timeout;

  private constructor(
    readonly hostDir: string,
    private readonly limits: SandboxLimits,
    private readonly log: (msg: string) => void,
  ) {
    this.timer = setTimeout(() => {
      this.expired = true;
      this.log(`wall clock of ${Math.round(limits.wallClockMs / 60000)} min expired`);
    }, limits.wallClockMs);
    this.timer.unref();
  }

  static async create(opts: LocalSandboxOptions): Promise<LocalSandbox> {
    const log = opts.log ?? (() => {});
    const hostDir = path.resolve(opts.repoDir);
    await fs.access(hostDir);
    if (opts.seedNodeModulesFrom) {
      const seed = path.join(opts.seedNodeModulesFrom, "node_modules");
      const target = path.join(hostDir, "node_modules");
      try {
        await fs.access(seed);
        await fs.access(target).catch(async () => {
          await fs.symlink(seed, target, process.platform === "win32" ? "junction" : "dir");
          log(`linked node_modules from ${seed}`);
        });
      } catch {
        /* no seed available */
      }
    }
    return new LocalSandbox(hostDir, opts.limits, log);
  }

  hostPath(p: string): string {
    const rel = toWorkspaceRelative(p);
    return rel === "" ? this.hostDir : path.join(this.hostDir, ...rel.split("/"));
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.expired) throw new SandboxExpiredError();
    if (this.destroyed) throw new Error("sandbox destroyed");
    const timeoutMs = clampTimeout(opts.timeoutMs);
    const cwd = opts.cwd ? this.hostPath(opts.cwd) : this.hostDir;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CI: "true",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      TERM: "dumb",
      ...opts.env,
    };
    // Secrets never reach the sandboxed command, even in local mode.
    delete env["ANTHROPIC_API_KEY"];
    delete env["GITHUB_TOKEN"];
    delete env["GH_TOKEN"];
    if (this.networkOff) {
      // Best effort for a host process: make common HTTP clients fail fast.
      env["HTTP_PROXY"] = "http://127.0.0.1:9";
      env["HTTPS_PROXY"] = "http://127.0.0.1:9";
      env["NO_PROXY"] = "";
    }
    const started = Date.now();
    return new Promise<ExecResult>((resolve) => {
      const child = spawn("bash", ["-lc", command], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const killTree = () => {
        if (child.pid === undefined) return;
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < MAX_CAPTURE_BYTES) stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < MAX_CAPTURE_BYTES) stderr += d.toString("utf8");
      });
      const finish = (code: number | null) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: timedOut ? 124 : (code ?? 1),
          timedOut,
          durationMs: Date.now() - started,
          command,
        });
      };
      child.on("error", (err) => {
        stderr += `\n${err.message}`;
        finish(127);
      });
      child.on("close", (code) => finish(code));
    });
  }

  async readFile(p: string): Promise<string> {
    return fs.readFile(this.hostPath(p), "utf8");
  }

  async writeFile(p: string, content: string): Promise<void> {
    const target = this.hostPath(p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(this.hostPath(p));
      return true;
    } catch {
      return false;
    }
  }

  async disconnectNetwork(): Promise<void> {
    this.networkOff = true;
    this.log("local sandbox cannot drop the network interface; proxy variables now point at a dead port");
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.timer);
    // The workspace lives inside the run directory and is kept for inspection.
  }
}
