/**
 * Hard limits that do not depend on the model behaving: a command denylist,
 * output truncation, and the step/budget caps checked by the loop.
 */

export interface DenyRule {
  pattern: RegExp;
  reason: string;
}

export const DENYLIST: DenyRule[] = [
  { pattern: /\brm\s+(-[A-Za-z]*\s+)*(\/|\/\*|~|~\/|\*|\.\.|\$HOME)(\s|$)/, reason: "recursive delete of the root, home or parent directory" },
  { pattern: /--no-preserve-root/, reason: "rm --no-preserve-root" },
  { pattern: /\bgit\s+push\b/, reason: "git push is done by the host after review, never from the sandbox" },
  { pattern: /\bgit\s+remote\s+(add|set-url)\b/, reason: "changing git remotes" },
  { pattern: /\bcurl\b/, reason: "network access (curl) is not allowed; the sandbox is offline" },
  { pattern: /\bwget\b/, reason: "network access (wget) is not allowed; the sandbox is offline" },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/, reason: "publishing packages" },
  { pattern: /\btwine\s+upload\b/, reason: "publishing packages" },
  { pattern: /\buv\s+publish\b/, reason: "publishing packages" },
  { pattern: /\bcargo\s+publish\b/, reason: "publishing packages" },
  { pattern: /\bgem\s+push\b/, reason: "publishing packages" },
  { pattern: /\bdocker\b/, reason: "docker is not available inside the sandbox" },
  { pattern: /\bsudo\b|\bsu\s+-?\s*root\b/, reason: "privilege escalation" },
  { pattern: /\b(shutdown|reboot|halt|poweroff|mkfs(\.\w+)?)\b/, reason: "system-level command" },
  { pattern: /\bdd\s+if=/, reason: "raw disk writes" },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/, reason: "fork bomb" },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777\s+\//, reason: "world-writable root" },
  { pattern: /\bssh\b|\bscp\b|\bnc\b|\bncat\b|\bnetcat\b|\btelnet\b/, reason: "network tools" },
];

/** Returns the reason a command is denied, or null when it is allowed. */
export function denyReason(command: string): string | null {
  const flat = command.replace(/\s+/g, " ");
  for (const rule of DENYLIST) {
    if (rule.pattern.test(flat)) return rule.reason;
  }
  return null;
}

export const MAX_TOOL_OUTPUT_CHARS = 10_000;

/**
 * Keep the head and the tail of long output. The tail usually has the
 * failing assertion; the head has the command banner.
 */
export function truncateOutput(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.6);
  const tailLen = max - headLen;
  const omitted = text.length - max;
  return (
    text.slice(0, headLen) +
    `\n\n[... output truncated: ${omitted.toLocaleString()} of ${text.length.toLocaleString()} characters omitted; ` +
    `showing first ${headLen.toLocaleString()} and last ${tailLen.toLocaleString()} ...]\n\n` +
    text.slice(text.length - tailLen)
  );
}

export interface RunLimits {
  /** Model turns (API calls) allowed for the whole run. */
  maxSteps: number;
  /** Model turns allowed to reproduce the bug before giving up. */
  reproduceMaxSteps: number;
  /** Spend cap in USD, computed from `usage` after every turn. */
  budgetUsd: number;
  /** Input tokens after which context editing is switched on. */
  contextEditThresholdTokens: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxSteps: 60,
  reproduceMaxSteps: 20,
  budgetUsd: 5,
  contextEditThresholdTokens: 150_000,
};
