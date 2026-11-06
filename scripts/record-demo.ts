/**
 * Records a real `pnpm fix` run as docs/demo.gif.
 *
 * The CLI is spawned for real and its terminal output captured with
 * timestamps. Each output burst becomes one frame, rendered in a headless
 * Chromium "terminal" and encoded with gifenc. Nothing is staged: the frames
 * are exactly what the terminal printed.
 *
 *   pnpm demo:gif                       # mock provider, local sandbox, dry run on demo issue 1
 *   pnpm demo:gif -- <args for fix...>  # any other fix invocation (e.g. a live run with a key)
 *   DEMO_OUT=docs/other.gif pnpm demo:gif
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import gifenc from "gifenc";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

// gifenc ships CommonJS; the named exports are on the default object.
const { applyPalette, GIFEncoder, quantize } = gifenc;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(root, process.env["DEMO_OUT"] ?? "docs/demo.gif");
const WIDTH = 960;
const HEIGHT = 600;
const ROWS = 30;
const MAX_SECONDS = 40;

const extra = process.argv.slice(2);
const fixArgs = extra.length
  ? extra
  : ["jumilandelapena/demo-inventory-api#1", "--sandbox", "local", "--repo-path", "demo-repo", "--issues-file", "demo-repo/issues.json", "--dry-run"];
const command = `pnpm fix ${fixArgs.join(" ")}`;

interface Chunk {
  t: number;
  text: string;
}

async function capture(): Promise<{ chunks: Chunk[]; code: number }> {
  const chunks: Chunk[] = [];
  const started = Date.now();
  const child = spawn("pnpm", ["exec", "tsx", "src/cli/index.ts", "fix", ...fixArgs], {
    cwd: root,
    shell: true,
    env: { ...process.env, FORCE_COLOR: "1", LLM_PROVIDER: process.env["LLM_PROVIDER"] ?? (extra.length ? "anthropic" : "mock") },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const push = (d: Buffer) => {
    const text = d.toString("utf8");
    chunks.push({ t: Date.now() - started, text });
    process.stdout.write(text);
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  return { chunks, code };
}

const CSS: Record<number, string> = {
  1: "b",
  2: "dim",
  30: "c30",
  31: "c31",
  32: "c32",
  33: "c33",
  34: "c34",
  35: "c35",
  36: "c36",
  37: "c37",
  90: "c90",
  91: "c31",
  92: "c32",
  93: "c33",
  94: "c34",
  95: "c35",
  96: "c36",
  97: "c37",
};

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** Minimal SGR -> HTML converter for the 16-colour codes chalk emits. */
function ansiToHtml(line: string): string {
  let html = "";
  let open: string[] = [];
  const classes = new Set<string>();
  const flush = () => {
    if (open.length) html += "</span>".repeat(open.length);
    open = [];
    if (classes.size) {
      html += `<span class="${[...classes].join(" ")}">`;
      open.push("span");
    }
  };
  const re = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    html += esc(line.slice(last, m.index));
    last = m.index! + m[0].length;
    for (const code of (m[1] || "0").split(";").map(Number)) {
      if (code === 0) classes.clear();
      else if (code === 22) {
        classes.delete("b");
        classes.delete("dim");
      } else if (code === 39) for (const c of [...classes]) if (c.startsWith("c")) classes.delete(c);
      else if (CSS[code]) {
        if (CSS[code]!.startsWith("c")) for (const c of [...classes]) if (c.startsWith("c")) classes.delete(c);
        classes.add(CSS[code]!);
      }
    }
    flush();
  }
  html += esc(line.slice(last));
  if (open.length) html += "</span>".repeat(open.length);
  return html;
}

function frameHtml(lines: string[], done: boolean): string {
  const visible = lines.slice(-ROWS);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0f1117}
  .term{width:${WIDTH}px;height:${HEIGHT}px;box-sizing:border-box;padding:14px 18px;background:#0f1117;color:#e6e8ef;
    font:13px/1.5 "Cascadia Mono","JetBrains Mono",Consolas,Menlo,monospace;white-space:pre-wrap;word-break:break-all;overflow:hidden}
  .bar{height:14px;margin:-6px 0 8px;display:flex;gap:6px}.bar i{width:11px;height:11px;border-radius:50%;display:block}
  .b{font-weight:700}.dim{color:#8b93a7}.c30{color:#6b7280}.c31{color:#f7768e}.c32{color:#9ece6a}.c33{color:#e0af68}.c34{color:#7aa2f7}
  .c35{color:#bb9af7}.c36{color:#7dcfff}.c37{color:#e6e8ef}.c90{color:#8b93a7}
  .cursor{display:inline-block;width:7px;height:14px;background:#e6e8ef;vertical-align:-2px;${done ? "opacity:0" : ""}}
  </style></head><body><div class="term"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>${visible
    .map(ansiToHtml)
    .join("\n")}<span class="cursor"></span></div></body></html>`;
}

async function main(): Promise<void> {
  console.log(`recording: ${command}\n`);
  const { chunks, code } = await capture();
  console.log(`\ncommand exited with ${code}; ${chunks.length} output chunks captured`);

  // Build frames: one per burst of output (chunks closer than 120 ms are merged).
  const frames: Array<{ lines: string[]; t: number }> = [];
  let text = `$ ${command}\n`;
  let lastT = -1;
  const linesOf = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "").split("\n");
  frames.push({ lines: linesOf(text), t: 0 });
  for (const c of chunks) {
    text += c.text;
    if (lastT >= 0 && c.t - lastT < 120) frames[frames.length - 1] = { lines: linesOf(text), t: frames[frames.length - 1]!.t };
    else frames.push({ lines: linesOf(text), t: c.t });
    lastT = c.t;
  }
  const total = frames[frames.length - 1]!.t || 1;
  const scale = Math.min(1, (MAX_SECONDS * 1000) / total);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const next = frames[i + 1];
    const last = i === frames.length - 1;
    await page.setContent(frameHtml(f.lines, last));
    const shot = await page.screenshot({ type: "png" });
    if (last && process.env["DEMO_FRAME_PNG"]) fs.writeFileSync(path.resolve(root, process.env["DEMO_FRAME_PNG"]), shot);
    const png = PNG.sync.read(shot);
    const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    const delay = last ? 3500 : Math.max(80, Math.min(1500, Math.round((next!.t - f.t) * scale)));
    gif.writeFrame(index, WIDTH, HEIGHT, { palette, delay, repeat: 0 });
    process.stdout.write(`\rframe ${i + 1}/${frames.length}`);
  }
  gif.finish();
  await browser.close();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, gif.bytes());
  console.log(`\nwrote ${out} (${(gif.bytes().length / 1024).toFixed(0)} KB, ${frames.length} frames, ${(Math.min(total, MAX_SECONDS * 1000) / 1000).toFixed(0)} s)`);
  if (code !== 0) process.exitCode = code;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
