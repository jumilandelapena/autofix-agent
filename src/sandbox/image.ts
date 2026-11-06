/**
 * Builds the sandbox image from sandbox/Dockerfile (git, Node 20, Python 3.11
 * + uv, Go, ripgrep, non-root user). Idempotent: an existing image is reused
 * unless `force` is set.
 */
import Dockerode from "dockerode";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDockerClient, DEFAULT_IMAGE } from "./docker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SANDBOX_DIR = path.resolve(here, "../../sandbox");

export async function imageExists(tag: string, docker: Dockerode = createDockerClient()): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

export interface BuildImageOptions {
  tag?: string | undefined;
  force?: boolean | undefined;
  docker?: Dockerode | undefined;
  log?: ((msg: string) => void) | undefined;
}

export async function ensureSandboxImage(opts: BuildImageOptions = {}): Promise<string> {
  const tag = opts.tag ?? DEFAULT_IMAGE;
  const docker = opts.docker ?? createDockerClient();
  const log = opts.log ?? (() => {});
  if (!opts.force && (await imageExists(tag, docker))) {
    log(`image ${tag} already present`);
    return tag;
  }
  if (tag !== DEFAULT_IMAGE && !opts.force) {
    throw new Error(`image ${tag} not found locally; pull it or pass the default image`);
  }
  log(`building ${tag} from ${SANDBOX_DIR}/Dockerfile`);
  const stream = await docker.buildImage({ context: SANDBOX_DIR, src: ["Dockerfile"] }, { t: tag });
  await new Promise<void>((resolve, reject) => {
    const modem = docker.modem as {
      followProgress: (
        s: NodeJS.ReadableStream,
        onFinished: (err: Error | null, output: unknown[]) => void,
        onProgress?: (event: { stream?: string; error?: string }) => void,
      ) => void;
    };
    modem.followProgress(
      stream,
      (err, output) => {
        if (err) return reject(err);
        const failed = (output as Array<{ error?: string }>).find((e) => e.error);
        if (failed) return reject(new Error(failed.error));
        resolve();
      },
      (event) => {
        if (event.error) log(event.error);
        else if (event.stream && /^Step |^ ---> |Successfully/.test(event.stream)) log(event.stream.trim());
      },
    );
  });
  log(`built ${tag}`);
  return tag;
}
