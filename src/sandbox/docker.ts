/**
 * Docker sandbox: one fresh container per run, non-root user, CPU/memory/pid
 * limits, a wall clock that kills the container, and a network that is
 * disconnected after dependencies are installed.
 *
 * Nothing from the host environment is passed into the container. The
 * repository is copied in as a tar stream, and the diff is copied out as a
 * patch, so no host directory is ever bind-mounted.
 */
import Dockerode from "dockerode";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import tar from "tar-stream";
import {
  clampTimeout,
  MAX_CAPTURE_BYTES,
  SandboxExpiredError,
  shellQuote,
  toWorkspaceRelative,
  WORKSPACE,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxLimits,
} from "./types.js";

export const DEFAULT_IMAGE = "autofix-sandbox:latest";
export const SANDBOX_USER = "agent";
const SANDBOX_UID = 1000;

export interface DockerSandboxOptions {
  /** Host directory with the cloned repository; copied into /workspace. */
  repoDir: string;
  image: string;
  limits: SandboxLimits;
  runId: string;
  log?: ((msg: string) => void) | undefined;
  docker?: Dockerode | undefined;
}

export function createDockerClient(): Dockerode {
  // dockerode reads DOCKER_HOST / DOCKER_CERT_PATH and falls back to the
  // platform socket (/var/run/docker.sock or //./pipe/docker_engine).
  return new Dockerode();
}

export async function dockerAvailable(docker: Dockerode = createDockerClient()): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/** Pack a directory into a tar stream with every entry owned by the sandbox user. */
export function packDirectory(dir: string, opts: { uid?: number; gid?: number } = {}): tar.Pack {
  const pack = tar.pack();
  const uid = opts.uid ?? SANDBOX_UID;
  const gid = opts.gid ?? SANDBOX_UID;
  const walk = async (current: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await new Promise<void>((resolve, reject) =>
          pack.entry({ name: `${name}/`, type: "directory", mode: 0o755, uid, gid }, (err) =>
            err ? reject(err) : resolve(),
          ),
        );
        await walk(abs, name);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        const data = await fs.readFile(abs);
        const mode = stat.mode & 0o111 ? 0o755 : 0o644;
        await new Promise<void>((resolve, reject) =>
          pack.entry({ name, size: data.length, mode, uid, gid, mtime: stat.mtime }, data, (err) =>
            err ? reject(err) : resolve(),
          ),
        );
      }
    }
  };
  walk(dir, "")
    .then(() => pack.finalize())
    .catch((err) => pack.destroy(err as Error));
  return pack;
}

function singleFileTar(name: string, content: string): tar.Pack {
  const pack = tar.pack();
  const data = Buffer.from(content, "utf8");
  pack.entry({ name, size: data.length, mode: 0o644, uid: SANDBOX_UID, gid: SANDBOX_UID }, data, (err) => {
    if (err) pack.destroy(err);
    else pack.finalize();
  });
  return pack;
}

class CaptureStream extends Writable {
  text = "";
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    if (this.text.length < MAX_CAPTURE_BYTES) this.text += chunk.toString("utf8");
    cb();
  }
}

export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly workspace = WORKSPACE;
  expired = false;
  private destroyed = false;
  private readonly timer: NodeJS.Timeout;

  private constructor(
    private readonly docker: Dockerode,
    readonly container: Dockerode.Container,
    readonly containerId: string,
    private readonly log: (msg: string) => void,
    limits: SandboxLimits,
  ) {
    this.timer = setTimeout(() => {
      this.expired = true;
      this.log(`wall clock of ${Math.round(limits.wallClockMs / 60000)} min expired; killing container`);
      void container.kill().catch(() => {});
    }, limits.wallClockMs);
    this.timer.unref();
  }

  static async create(opts: DockerSandboxOptions): Promise<DockerSandbox> {
    const log = opts.log ?? (() => {});
    const docker = opts.docker ?? createDockerClient();
    const { limits } = opts;
    const container = await docker.createContainer({
      Image: opts.image,
      Cmd: ["sleep", "infinity"],
      User: SANDBOX_USER,
      WorkingDir: WORKSPACE,
      Tty: false,
      Env: ["CI=true", "FORCE_COLOR=0", "NO_COLOR=1", "TERM=dumb", "HOME=/home/agent"],
      Labels: { "autofix-agent": "1", "autofix-agent.run": opts.runId },
      HostConfig: {
        Memory: limits.memoryBytes,
        MemorySwap: limits.memoryBytes, // no swap beyond the memory limit
        NanoCpus: Math.round(limits.cpus * 1e9),
        PidsLimit: limits.pidsLimit,
        SecurityOpt: ["no-new-privileges"],
        CapDrop: ["NET_RAW", "SYS_ADMIN", "SYS_PTRACE", "NET_ADMIN", "MKNOD", "AUDIT_WRITE"],
        AutoRemove: false,
      },
    });
    await container.start();
    const sb = new DockerSandbox(docker, container, container.id, log, limits);
    log(`container ${container.id.slice(0, 12)} started from ${opts.image}`);
    try {
      await container.putArchive(packDirectory(opts.repoDir) as unknown as NodeJS.ReadableStream, { path: WORKSPACE });
      // putArchive keeps the tar ownership; fix anything the daemon remapped.
      await sb.exec(`chown -R ${SANDBOX_USER}:${SANDBOX_USER} ${WORKSPACE}`, { asRoot: true, timeoutMs: 60_000 });
      log("repository copied into /workspace");
    } catch (err) {
      await sb.destroy();
      throw err;
    }
    return sb;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.expired) throw new SandboxExpiredError();
    if (this.destroyed) throw new Error("sandbox destroyed");
    const timeoutMs = clampTimeout(opts.timeoutMs);
    const seconds = Math.ceil(timeoutMs / 1000);
    const cwd = opts.cwd ? `${WORKSPACE}/${toWorkspaceRelative(opts.cwd)}`.replace(/\/$/, "") : WORKSPACE;
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const started = Date.now();
    const exec = await this.container.exec({
      // `timeout` enforces the per-command limit inside the container; the
      // host-side timer below is a safety net if the daemon stops responding.
      Cmd: ["timeout", "-k", "5", String(seconds), "bash", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: opts.asRoot ? "root" : SANDBOX_USER,
      WorkingDir: cwd,
      Env: env,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = new CaptureStream();
    const err = new CaptureStream();
    const demux = this.docker.modem as { demuxStream: (s: NodeJS.ReadableStream, o: Writable, e: Writable) => void };
    demux.demuxStream(stream, out, err);
    let hostTimedOut = false;
    await new Promise<void>((resolve) => {
      const guard = setTimeout(() => {
        hostTimedOut = true;
        (stream as PassThrough).destroy();
        resolve();
      }, timeoutMs + 15_000);
      stream.on("end", () => {
        clearTimeout(guard);
        resolve();
      });
      stream.on("close", () => {
        clearTimeout(guard);
        resolve();
      });
      stream.on("error", () => {
        clearTimeout(guard);
        resolve();
      });
    });
    let exitCode = 1;
    try {
      const info = await exec.inspect();
      exitCode = info.ExitCode ?? 1;
    } catch {
      /* container gone */
    }
    const timedOut = hostTimedOut || exitCode === 124 || (exitCode === 137 && Date.now() - started >= timeoutMs);
    return {
      stdout: out.text,
      stderr: err.text,
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
      durationMs: Date.now() - started,
      command,
    };
  }

  async readFile(p: string): Promise<string> {
    const rel = toWorkspaceRelative(p);
    const res = await this.exec(`cat -- ${shellQuote(`${WORKSPACE}/${rel}`)}`, { timeoutMs: 30_000 });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `cannot read ${p}`);
    return res.stdout;
  }

  async writeFile(p: string, content: string): Promise<void> {
    const rel = toWorkspaceRelative(p);
    if (rel === "") throw new Error("cannot write to the workspace root");
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const absDir = dir ? `${WORKSPACE}/${dir}` : WORKSPACE;
    if (dir) await this.exec(`mkdir -p -- ${shellQuote(absDir)}`, { timeoutMs: 30_000 });
    await this.container.putArchive(singleFileTar(base, content) as unknown as NodeJS.ReadableStream, { path: absDir });
  }

  async exists(p: string): Promise<boolean> {
    const rel = toWorkspaceRelative(p);
    const res = await this.exec(`test -e ${shellQuote(`${WORKSPACE}/${rel}`)}`, { timeoutMs: 30_000 });
    return res.exitCode === 0;
  }

  async disconnectNetwork(): Promise<void> {
    const info = await this.container.inspect();
    const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
    for (const name of networks) {
      await this.docker.getNetwork(name).disconnect({ Container: this.containerId, Force: true });
      this.log(`disconnected from network "${name}"`);
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.timer);
    try {
      await this.container.remove({ force: true, v: true });
      this.log(`container ${this.containerId.slice(0, 12)} removed`);
    } catch (err) {
      this.log(`container removal failed: ${(err as Error).message}`);
    }
  }
}
