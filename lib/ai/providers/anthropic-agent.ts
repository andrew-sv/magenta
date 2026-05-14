import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatMessage,
  ChatProvider,
  GenerateObjectParams,
  StreamChunk,
  StreamParams,
} from "../types";

/**
 * Adapter over the Claude Agent SDK. Authenticates via `~/.claude/` credentials
 * (set up by `claude login`). All calls run with tools disabled — we use the SDK
 * purely as an LLM client, not as an agent.
 */
class AnthropicAgentProvider implements ChatProvider {
  readonly providerId = "anthropic" as const;

  async *stream(params: StreamParams): AsyncIterable<StreamChunk> {
    const { prompt, abortController } = buildPrompt(params);

    const options: Options = {
      model: params.modelName,
      tools: [],
      includePartialMessages: true,
      abortController,
      ...(params.system ? { systemPrompt: params.system } : {}),
    };

    const iter = query({ prompt, options });
    let lastEmittedTextLen = 0;

    try {
      for await (const msg of iter as AsyncIterable<SDKMessage>) {
        if (params.signal.aborted) break;

        if (msg.type === "stream_event") {
          const event = msg.event as { type?: string; delta?: { type?: string; text?: string } };
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const delta = event.delta.text ?? "";
            if (delta) yield { type: "text-delta", delta };
          }
          continue;
        }

        if (msg.type === "assistant" && msg.error) {
          throw mapAgentError(msg.error);
        }

        // Fallback: if partial events were missed, emit the diff from the final assistant message.
        if (msg.type === "assistant" && !msg.error) {
          const fullText = extractAssistantText(msg);
          if (fullText.length > lastEmittedTextLen) {
            const tail = fullText.slice(lastEmittedTextLen);
            if (tail) yield { type: "text-delta", delta: tail };
            lastEmittedTextLen = fullText.length;
          }
        }

        if (msg.type === "result") break;
      }
    } finally {
      if (params.signal.aborted && !abortController.signal.aborted) {
        abortController.abort();
      }
    }
  }

  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T | null> {
    const jsonInstruction =
      "Respond with a single JSON object only. No prose, no markdown fences, no preamble. " +
      "The JSON must conform to the requested shape.";

    const system = [params.system, jsonInstruction].filter(Boolean).join("\n\n");

    for (let attempt = 0; attempt < 3; attempt++) {
      if (params.signal.aborted) return null;

      let acc = "";
      try {
        for await (const chunk of this.stream({
          modelName: params.modelName,
          messages: params.messages,
          system,
          signal: params.signal,
        })) {
          acc += chunk.delta;
        }
      } catch (err) {
        if (params.signal.aborted) return null;
        if (attempt === 2) throw err;
        continue;
      }

      const parsed = tryParseJson(acc);
      if (parsed === undefined) continue;
      const result = params.schema.safeParse(parsed);
      if (result.success) return result.data;
    }

    return null;
  }
}

export const anthropicAgentProvider = new AnthropicAgentProvider();

function buildPrompt(params: StreamParams): {
  prompt: string;
  abortController: AbortController;
} {
  // Single-turn: just send the user content.
  // Multi-turn: format prior turns as a transcript followed by the latest user turn.
  let prompt: string;
  if (params.messages.length === 0) {
    prompt = "";
  } else if (params.messages.length === 1 && params.messages[0].role === "user") {
    prompt = params.messages[0].content;
  } else {
    const lines: string[] = [];
    for (let i = 0; i < params.messages.length - 1; i++) {
      const m = params.messages[i];
      if (m.role === "system") continue;
      lines.push(`${capitalize(m.role)}: ${m.content}`);
    }
    const last = params.messages[params.messages.length - 1];
    lines.push("");
    lines.push(last.role === "user" ? last.content : `${capitalize(last.role)}: ${last.content}`);
    prompt = lines.join("\n");
  }

  const abortController = new AbortController();
  // Bridge the upstream signal so caller-side cancellation flows through to the SDK.
  if (params.signal.aborted) abortController.abort();
  else params.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  return { prompt, abortController };
}

function extractAssistantText(msg: Extract<SDKMessage, { type: "assistant" }>): string {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      out += (part as { text?: string }).text ?? "";
    }
  }
  return out;
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Strip ```json fences if a model added them despite instructions.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Try to recover the first {...} block.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function mapAgentError(err: string): Error {
  switch (err) {
    case "authentication_failed":
      return new Error(
        "Claude authentication failed. Run `claude login` to authenticate the Claude Agent SDK against your Pro/Max subscription.",
      );
    case "rate_limit":
      return new Error(
        "Claude rate limit hit. Your Pro/Max subscription quota is temporarily exhausted.",
      );
    case "billing_error":
      return new Error("Claude billing error reported by the Agent SDK.");
    default:
      return new Error(`Claude Agent SDK error: ${err}`);
  }
}

export type { ChatMessage };
