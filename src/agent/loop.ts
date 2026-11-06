/**
 * The agent loop, written by hand: call the Messages API, execute every
 * tool_use block, append all tool_result blocks in one user message, repeat
 * until submit is accepted or a limit is hit.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { SandboxExpiredError } from "../sandbox/types.js";
import type { RunLimits } from "./limits.js";
import { addUsage, costOf, emptyTotals, promptTokens, type UsageTotals } from "./pricing.js";
import { NUDGE_CONTINUE, NUDGE_MAX_TOKENS } from "./prompt.js";
import type { LlmProvider, LlmResponse } from "./provider.js";
import { executeTool, type ToolContext, type ToolOutcome } from "./tools.js";

export type Outcome =
  | "submitted"
  | "not_reproduced"
  | "max_steps"
  | "budget_exceeded"
  | "refusal"
  | "stalled"
  | "sandbox_expired"
  | "error";

export interface TurnInfo {
  turn: number;
  text: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  toolResults: Array<{ name: string; isError: boolean; content: string }>;
  usage: LlmResponse["usage"];
  totals: UsageTotals;
  phase: string;
  contextEditing: boolean;
}

export interface AgentLoopOptions {
  provider: LlmProvider;
  system: string;
  tools: Anthropic.Tool[];
  firstUserMessage: string;
  ctx: ToolContext;
  limits: RunLimits;
  onTurn?: ((info: TurnInfo) => void) | undefined;
}

export interface AgentResult {
  outcome: Outcome;
  detail: string;
  totals: UsageTotals;
  turns: number;
  messages: Anthropic.MessageParam[];
  refusal?: { category: string | null; explanation: string | null } | undefined;
}

const MAX_NUDGES = 2;

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentResult> {
  const { provider, ctx, limits } = opts;
  const { trajectory, state } = ctx;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.firstUserMessage }];
  let totals = emptyTotals();
  let turn = 0;
  let nudges = 0;
  let contextEditing = false;

  const finish = (outcome: Outcome, detail: string, extra: Partial<AgentResult> = {}): AgentResult => {
    if (outcome !== "submitted") trajectory.log({ type: "limit", kind: outcome, detail });
    return { outcome, detail, totals, turns: turn, messages, ...extra };
  };

  while (true) {
    if (turn >= limits.maxSteps) return finish("max_steps", `reached the step limit of ${limits.maxSteps} turns`);
    if (state.phase === "reproduce" && turn >= limits.reproduceMaxSteps) {
      return finish("not_reproduced", `could not reproduce the bug within ${limits.reproduceMaxSteps} turns`);
    }
    if (totals.costUsd >= limits.budgetUsd) {
      return finish("budget_exceeded", `spent $${totals.costUsd.toFixed(4)} of the $${limits.budgetUsd.toFixed(2)} budget`);
    }
    if (ctx.sandbox.expired) return finish("sandbox_expired", "the sandbox wall clock expired");

    turn++;
    trajectory.log({ type: "api_request", turn, messageCount: messages.length, contextEditing, model: provider.model });

    let response: LlmResponse;
    try {
      response = await provider.createMessage({ system: opts.system, tools: opts.tools, messages, contextEditing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return finish("error", `API call failed: ${message}`);
    }

    totals = addUsage(totals, response.usage, provider.model);
    const costThisTurn = costOf(response.usage, provider.model);
    trajectory.log({
      type: "api_response",
      turn,
      stop_reason: response.stop_reason,
      content: response.content,
      usage: response.usage,
      cost_usd: Number(costThisTurn.toFixed(6)),
      cumulative: totals,
      context_management: response.context_management,
    });
    if (promptTokens(response.usage) > limits.contextEditThresholdTokens && !contextEditing) {
      contextEditing = true;
      trajectory.info(`prompt reached ${promptTokens(response.usage)} tokens; context editing enabled for the next turns`);
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      const details = (response.stop_details ?? {}) as { category?: string | null; explanation?: string | null };
      return finish("refusal", `the model declined to continue (${details.category ?? "unspecified"})`, {
        refusal: { category: details.category ?? null, explanation: details.explanation ?? null },
      });
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (response.stop_reason === "max_tokens") {
      // Inputs may be truncated: never run them. Answer every tool_use so the
      // conversation stays valid, then ask the model to continue.
      const results: Anthropic.ToolResultBlockParam[] = toolUses.map((t) => ({
        type: "tool_result",
        tool_use_id: t.id,
        is_error: true,
        content: "not executed: the response hit the output token limit and this tool input may be truncated. Re-issue the call.",
      }));
      messages.push({ role: "user", content: [...results, { type: "text", text: NUDGE_MAX_TOKENS }] });
      opts.onTurn?.({ turn, text, toolCalls: toolUses.map((t) => ({ name: t.name, input: t.input })), toolResults: [], usage: response.usage, totals, phase: state.phase, contextEditing });
      continue;
    }

    if (response.stop_reason === "pause_turn") {
      continue;
    }

    if (toolUses.length === 0) {
      nudges++;
      if (nudges > MAX_NUDGES) return finish("stalled", "the model stopped calling tools without submitting");
      messages.push({ role: "user", content: NUDGE_CONTINUE });
      opts.onTurn?.({ turn, text, toolCalls: [], toolResults: [], usage: response.usage, totals, phase: state.phase, contextEditing });
      continue;
    }
    nudges = 0;

    const results: Anthropic.ToolResultBlockParam[] = [];
    const turnResults: TurnInfo["toolResults"] = [];
    let done = false;
    for (const use of toolUses) {
      trajectory.log({ type: "tool_call", turn, id: use.id, name: use.name, input: use.input });
      const started = Date.now();
      let outcome: ToolOutcome;
      try {
        outcome = await executeTool(use.name, use.input, ctx);
      } catch (err) {
        if (err instanceof SandboxExpiredError) {
          trajectory.log({ type: "tool_result", turn, id: use.id, name: use.name, is_error: true, content: err.message, duration_ms: Date.now() - started });
          return finish("sandbox_expired", "the sandbox wall clock expired during a tool call");
        }
        outcome = { content: `${use.name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      trajectory.log({
        type: "tool_result",
        turn,
        id: use.id,
        name: use.name,
        is_error: outcome.isError,
        content: outcome.content,
        duration_ms: Date.now() - started,
      });
      results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, is_error: outcome.isError });
      turnResults.push({ name: use.name, isError: outcome.isError, content: outcome.content });
      if (outcome.done) done = true;
    }

    const notices = state.notices.splice(0, state.notices.length);
    const content: Anthropic.ContentBlockParam[] = [...results, ...notices.map((n) => ({ type: "text" as const, text: n }))];
    messages.push({ role: "user", content });

    opts.onTurn?.({
      turn,
      text,
      toolCalls: toolUses.map((t) => ({ name: t.name, input: t.input })),
      toolResults: turnResults,
      usage: response.usage,
      totals,
      phase: state.phase,
      contextEditing,
    });

    if (done) return finish("submitted", "submission verified by the harness");
  }
}
