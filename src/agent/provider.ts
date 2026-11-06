/**
 * LLM providers. `AnthropicProvider` calls the Messages API with streaming,
 * prompt caching and (past 150k input tokens) context editing.
 * `MockProvider` replays a recorded trajectory so tests and CI run without a
 * key or network.
 */
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { DEFAULT_MODEL, type UsageLike } from "./pricing.js";

export const MAX_OUTPUT_TOKENS = 16_000;
export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

export interface LlmRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  /** Switch on server-side clearing of old tool results. */
  contextEditing: boolean;
}

export interface LlmResponse {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.Message["stop_reason"];
  stop_details?: unknown;
  usage: UsageLike;
  model: string;
  context_management?: unknown;
}

export interface LlmProvider {
  readonly name: "anthropic" | "mock";
  readonly model: string;
  createMessage(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Keep exactly two cache breakpoints: the system prompt and the latest tool
 * result. Older breakpoints are stripped so the request never exceeds the
 * four-breakpoint limit, and the whole prefix up to the latest result is
 * served from cache on the next turn.
 */
export function withCacheOnLatestResult(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const cloned: Anthropic.MessageParam[] = messages.map((m): Anthropic.MessageParam => {
    if (typeof m.content === "string") return { ...m, content: m.content };
    const content = (m.content as Array<Anthropic.ContentBlockParam & { cache_control?: unknown }>).map((block) => {
      const { cache_control: _dropped, ...rest } = block;
      return rest as Anthropic.ContentBlockParam;
    });
    return { ...m, content } as Anthropic.MessageParam;
  });
  const last = cloned[cloned.length - 1];
  if (!last || last.role !== "user") return cloned;
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    return cloned;
  }
  const blocks = last.content;
  const tail = blocks[blocks.length - 1];
  if (tail && (tail.type === "tool_result" || tail.type === "text")) {
    blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
  }
  return cloned;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(
    readonly model: string = DEFAULT_MODEL,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ maxRetries: 3 });
  }

  async createMessage(req: LlmRequest): Promise<LlmResponse> {
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
    const messages = withCacheOnLatestResult(req.messages);

    if (!req.contextEditing) {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        tools: req.tools,
        messages,
        output_config: { effort: "high" },
      });
      const msg = await stream.finalMessage();
      return {
        content: msg.content,
        stop_reason: msg.stop_reason,
        stop_details: msg.stop_details ?? undefined,
        usage: msg.usage,
        model: msg.model,
      };
    }

    // Past the threshold: same request through the beta surface with
    // context editing, so stale tool outputs are cleared server-side.
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      tools: req.tools as Anthropic.Beta.BetaToolUnion[],
      messages: messages as Anthropic.Beta.BetaMessageParam[],
      output_config: { effort: "high" },
      betas: [CONTEXT_MANAGEMENT_BETA],
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    });
    const msg = await stream.finalMessage();
    return {
      content: msg.content as unknown as Anthropic.ContentBlock[],
      stop_reason: msg.stop_reason as Anthropic.Message["stop_reason"],
      stop_details: msg.stop_details ?? undefined,
      usage: msg.usage,
      model: msg.model,
      context_management: msg.context_management ?? undefined,
    };
  }
}

/** One recorded assistant turn. Same shape as the `api_response` trajectory event. */
export interface MockTurn {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.Message["stop_reason"];
  usage?: UsageLike;
}

export interface MockFixture {
  issue: number;
  repo?: string;
  description?: string;
  model?: string;
  turns: MockTurn[];
}

export class MockProvider implements LlmProvider {
  readonly name = "mock" as const;
  readonly model: string;
  private index = 0;

  constructor(readonly fixture: MockFixture) {
    this.model = fixture.model ?? `${DEFAULT_MODEL} (mock replay)`;
  }

  static fromFile(file: string): MockProvider {
    const fixture = JSON.parse(fs.readFileSync(file, "utf8")) as MockFixture;
    if (!Array.isArray(fixture.turns) || fixture.turns.length === 0) throw new Error(`mock fixture ${file} has no turns`);
    return new MockProvider(fixture);
  }

  get remaining(): number {
    return this.fixture.turns.length - this.index;
  }

  async createMessage(_req: LlmRequest): Promise<LlmResponse> {
    const turn = this.fixture.turns[this.index];
    if (!turn) throw new Error(`mock fixture exhausted after ${this.index} turns`);
    this.index++;
    return {
      content: turn.content,
      stop_reason: turn.stop_reason,
      usage: turn.usage ?? { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      model: this.model,
    };
  }
}

export interface ProviderOptions {
  provider?: string | undefined;
  model?: string | undefined;
  fixturePath?: string | undefined;
}

export function createProvider(opts: ProviderOptions): LlmProvider {
  const kind = (opts.provider ?? process.env["LLM_PROVIDER"] ?? "anthropic").toLowerCase();
  if (kind === "mock") {
    if (!opts.fixturePath) throw new Error("mock provider needs a fixture path");
    return MockProvider.fromFile(opts.fixturePath);
  }
  if (kind !== "anthropic") throw new Error(`unknown LLM_PROVIDER "${kind}" (expected anthropic or mock)`);
  if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    throw new Error("ANTHROPIC_API_KEY is not set (or use LLM_PROVIDER=mock)");
  }
  return new AnthropicProvider(opts.model ?? process.env["AUTOFIX_MODEL"] ?? DEFAULT_MODEL);
}
