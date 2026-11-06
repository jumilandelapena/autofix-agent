import { describe, expect, it } from "vitest";
import { denyReason, MAX_TOOL_OUTPUT_CHARS, truncateOutput } from "../src/agent/limits.js";

describe("command denylist", () => {
  it("blocks destructive and network commands", () => {
    const denied = [
      "rm -rf /",
      "rm -rf /*",
      "rm -rf ~",
      "rm -rf ~/",
      "rm -fr $HOME",
      "sudo rm -rf --no-preserve-root /",
      "git push origin main",
      "git push --force",
      "curl https://example.com",
      "wget -O- http://x",
      "npm publish",
      "pnpm publish --no-git-checks",
      "yarn publish",
      "twine upload dist/*",
      "uv publish",
      "docker run ubuntu",
      "sudo apt-get install x",
      "dd if=/dev/zero of=/dev/sda",
      ":(){ :|:& };:",
      "ssh user@host",
    ];
    for (const cmd of denied) expect(denyReason(cmd), cmd).not.toBeNull();
  });

  it("allows normal development commands", () => {
    const allowed = [
      "npx vitest run",
      "npm test",
      "rm -rf node_modules/.cache",
      "rm -f tmp.txt",
      "git status",
      "git diff HEAD",
      "git log --oneline -5",
      "go test ./...",
      "uv run pytest -q",
      "cat src/app.ts | head -20",
      "echo 'curly braces are fine'",
      "node -e \"console.log(process.version)\"",
    ];
    for (const cmd of allowed) expect(denyReason(cmd), cmd).toBeNull();
  });

  it("explains why", () => {
    expect(denyReason("git push")).toMatch(/host/);
    expect(denyReason("curl x")).toMatch(/offline/);
  });
});

describe("truncateOutput", () => {
  it("returns short output unchanged", () => {
    expect(truncateOutput("hello")).toBe("hello");
    const exact = "x".repeat(MAX_TOOL_OUTPUT_CHARS);
    expect(truncateOutput(exact)).toBe(exact);
  });

  it("keeps the head and the tail and says how much was dropped", () => {
    const text = "H".repeat(8_000) + "M".repeat(20_000) + "T".repeat(8_000);
    const out = truncateOutput(text);
    expect(out.startsWith("H".repeat(100))).toBe(true);
    expect(out.endsWith("T".repeat(100))).toBe(true);
    expect(out).toMatch(/output truncated: 26,000 of 36,000 characters omitted/);
    expect(out.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 200);
  });

  it("honours a custom limit", () => {
    expect(truncateOutput("abcdefghij", 6)).toMatch(/^abc[\s\S]*hij$/);
  });
});
