/**
 * Price table (USD per million tokens) used to turn `usage` into a cost after
 * every turn. Cache writes cost 1.25x the input price (5-minute TTL); cache
 * reads are model-specific (0.05x on Claude Opus 5.5).
 */
import type Anthropic from "@anthropic-ai/sdk";

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

export const DEFAULT_MODEL = "claude-opus-5-5";

export function priceFor(model: string): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
}

export function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, turns: 0 };
}

export type UsageLike = Pick<Anthropic.Usage, "input_tokens" | "output_tokens"> &
  Partial<Pick<Anthropic.Usage, "cache_creation_input_tokens" | "cache_read_input_tokens">>;

export function costOf(usage: UsageLike, model: string): number {
  const p = priceFor(model);
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens * p.input + usage.output_tokens * p.output + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) /
    1_000_000
  );
}

export function addUsage(totals: UsageTotals, usage: UsageLike, model: string): UsageTotals {
  return {
    inputTokens: totals.inputTokens + usage.input_tokens,
    outputTokens: totals.outputTokens + usage.output_tokens,
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cache_creation_input_tokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
    costUsd: totals.costUsd + costOf(usage, model),
    turns: totals.turns + 1,
  };
}

/** Total prompt size of one request: uncached + cache writes + cache reads. */
export function promptTokens(usage: UsageLike): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;
}
