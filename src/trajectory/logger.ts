/**
 * Append-only JSONL trajectory. Every API call, tool call, tool result,
 * phase change and limit hit is one line, so a run can be replayed, audited
 * and rendered by trajectory.html.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TrajectoryEvent =
  | { type: "run_start"; issue: { url: string; title: string; number: number }; options: Record<string, unknown> }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "sandbox"; event: string; detail?: unknown }
  | { type: "baseline"; project: unknown; tests: unknown; lint?: unknown }
  | { type: "phase"; from: string; to: string; reason: string }
  | { type: "api_request"; turn: number; messageCount: number; contextEditing: boolean; model: string }
  | {
      type: "api_response";
      turn: number;
      stop_reason: string | null;
      content: unknown[];
      usage: unknown;
      cost_usd: number;
      cumulative: unknown;
      context_management?: unknown;
    }
  | { type: "tool_call"; turn: number; id: string; name: string; input: unknown }
  | { type: "tool_result"; turn: number; id: string; name: string; is_error: boolean; content: string; duration_ms: number }
  | { type: "limit"; kind: string; detail: string }
  | { type: "verification"; stage: string; ok: boolean; detail: unknown }
  | { type: "run_end"; outcome: string; summary: unknown };

export type LoggedEvent = TrajectoryEvent & { ts: string; seq: number };

export class TrajectoryLogger {
  private seq = 0;
  private readonly fd: number;
  readonly file: string;
  readonly events: LoggedEvent[] = [];

  constructor(readonly runDir: string) {
    fs.mkdirSync(runDir, { recursive: true });
    this.file = path.join(runDir, "trajectory.jsonl");
    this.fd = fs.openSync(this.file, "a");
    copyViewer(runDir);
  }

  log(event: TrajectoryEvent): LoggedEvent {
    const logged = { ...event, ts: new Date().toISOString(), seq: this.seq++ } as LoggedEvent;
    this.events.push(logged);
    fs.writeSync(this.fd, JSON.stringify(logged) + "\n");
    return logged;
  }

  info(message: string): void {
    this.log({ type: "log", level: "info", message });
  }

  warn(message: string): void {
    this.log({ type: "log", level: "warn", message });
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

export function viewerPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "trajectory.html");
}

/** Put a copy of the static viewer next to the JSONL so the run folder is self-contained. */
export function copyViewer(runDir: string): void {
  try {
    fs.copyFileSync(viewerPath(), path.join(runDir, "trajectory.html"));
  } catch {
    /* viewer missing in a stripped build; the JSONL is still written */
  }
}

export function readTrajectory(file: string): LoggedEvent[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LoggedEvent);
}
