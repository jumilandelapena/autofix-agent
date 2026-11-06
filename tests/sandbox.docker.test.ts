/**
 * Real Docker. Skipped automatically when no daemon is reachable (local dev
 * boxes without Docker); GitHub-hosted runners have it, so CI always runs it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient, DockerSandbox, dockerAvailable } from "../src/sandbox/docker.js";
import { ensureSandboxImage } from "../src/sandbox/image.js";
import { DEFAULT_LIMITS } from "../src/sandbox/types.js";

const docker = createDockerClient();
const available = await dockerAvailable(docker);

describe.skipIf(!available)("docker sandbox", () => {
  let repoDir: string;
  let sandbox: DockerSandbox;

  beforeAll(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "autofix-docker-"));
    await fs.writeFile(path.join(repoDir, "hello.txt"), "hello from the host\n");
    await fs.mkdir(path.join(repoDir, "sub"));
    await fs.writeFile(path.join(repoDir, "sub/n.txt"), "nested\n");
    const image = await ensureSandboxImage({ docker });
    sandbox = await DockerSandbox.create({ repoDir, image, limits: { ...DEFAULT_LIMITS, wallClockMs: 5 * 60_000 }, runId: "test", docker });
  }, 20 * 60_000);

  afterAll(async () => {
    await sandbox?.destroy();
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it("starts a container with the repo copied in and runs commands as the non-root user", async () => {
    const res = await sandbox.exec("whoami && pwd && cat hello.txt && cat sub/n.txt");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("agent\n/workspace\nhello from the host\nnested");
  });

  it("has the advertised toolchain", async () => {
    const res = await sandbox.exec("node --version && python3 --version && go version && rg --version | head -1 && uv --version && git --version");
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/v20\./);
    expect(res.stdout).toMatch(/Python 3\.11/);
    expect(res.stdout).toMatch(/go1\./);
    expect(res.stdout).toMatch(/ripgrep/);
  });

  it("reports non-zero exit codes and stderr without throwing", async () => {
    const res = await sandbox.exec("echo oops >&2; exit 7");
    expect(res.exitCode).toBe(7);
    expect(res.stderr).toContain("oops");
  });

  it("enforces the per-command timeout", async () => {
    const res = await sandbox.exec("sleep 20", { timeoutMs: 2_000 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
    expect(res.durationMs).toBeLessThan(15_000);
  });

  it("writes and reads files through the tar interface", async () => {
    await sandbox.writeFile("deep/dir/file.txt", "written\n");
    expect(await sandbox.readFile("deep/dir/file.txt")).toBe("written\n");
    expect(await sandbox.exists("deep/dir/file.txt")).toBe(true);
    const owner = await sandbox.exec("stat -c %U deep/dir/file.txt");
    expect(owner.stdout.trim()).toBe("agent");
  });

  it("has network before setup ends and none after disconnectNetwork()", async () => {
    const probe = `node -e "require('https').get('https://registry.npmjs.org/', r => { console.log('status', r.statusCode); process.exit(0) }).on('error', e => { console.log('ERR', e.code || e.message); process.exit(1) })"`;
    const before = await sandbox.exec(`timeout 20 ${probe}`, { timeoutMs: 30_000 });
    expect(before.stdout).toMatch(/status \d+/);
    await sandbox.disconnectNetwork();
    const after = await sandbox.exec(`timeout 20 ${probe}`, { timeoutMs: 30_000 });
    expect(after.exitCode).not.toBe(0);
    expect(after.stdout + after.stderr).toMatch(/ERR|timed out/);
    const ifaces = await sandbox.exec("ls /sys/class/net");
    expect(ifaces.stdout.trim().split("\n")).toEqual(["lo"]);
  });

  it("applies the resource limits", async () => {
    const info = await sandbox.container.inspect();
    expect(info.HostConfig.Memory).toBe(DEFAULT_LIMITS.memoryBytes);
    expect(info.HostConfig.NanoCpus).toBe(2_000_000_000);
    expect(info.HostConfig.PidsLimit).toBe(DEFAULT_LIMITS.pidsLimit);
    expect(info.Config.User).toBe("agent");
    expect(info.Config.Env.join(" ")).not.toMatch(/ANTHROPIC|GITHUB_TOKEN/);
  });
});

if (!available) {
  it("docker not available: sandbox tests skipped", () => {
    console.warn("Docker daemon not reachable; tests/sandbox.docker.test.ts skipped");
  });
}
