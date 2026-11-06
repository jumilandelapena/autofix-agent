import { DockerSandbox, DEFAULT_IMAGE, dockerAvailable } from "./docker.js";
import { ensureSandboxImage } from "./image.js";
import { LocalSandbox } from "./local.js";
import { DEFAULT_LIMITS, type Sandbox, type SandboxLimits } from "./types.js";

export type SandboxKind = "docker" | "local";

export interface CreateSandboxOptions {
  kind: SandboxKind;
  repoDir: string;
  runId: string;
  image?: string | undefined;
  limits?: Partial<SandboxLimits> | undefined;
  /** Local sandbox only: reuse node_modules from this directory. */
  seedNodeModulesFrom?: string | undefined;
  log?: ((msg: string) => void) | undefined;
}

export async function createSandbox(opts: CreateSandboxOptions): Promise<Sandbox> {
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const log = opts.log ?? (() => {});
  if (opts.kind === "local") {
    return LocalSandbox.create({ repoDir: opts.repoDir, limits, seedNodeModulesFrom: opts.seedNodeModulesFrom, log });
  }
  if (!(await dockerAvailable())) {
    throw new Error("Docker is not reachable. Start Docker, or pass --sandbox local (no isolation, for development only).");
  }
  const image = await ensureSandboxImage({ tag: opts.image ?? DEFAULT_IMAGE, log });
  return DockerSandbox.create({ repoDir: opts.repoDir, image, limits, runId: opts.runId, log });
}

export { DEFAULT_IMAGE, DockerSandbox, dockerAvailable, LocalSandbox, ensureSandboxImage };
export * from "./types.js";
export * from "./detect.js";
export * from "./testParser.js";
