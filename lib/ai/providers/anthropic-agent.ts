import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatMessage,
  ChatProvider,
  ContentPart,
  GenerateObjectParams,
  StreamChunk,
  StreamParams,
} from "../types";

/**
 * Flattens multimodal content to plain text. This adapter passes a single
 * prompt string to the Agent SDK and does not yet forward image parts; image
 * support for Claude is a separate change to `buildPrompt`.
 */
function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p: ContentPart): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Adapter over the Claude Agent SDK. Authenticates via `~/.claude/` credentials
 * (set up by `claude login`). All calls run with tools disabled — we use the SDK
 * purely as an LLM client, not as an agent.
 */
class AnthropicAgentProvider implements ChatProvider {
  readonly providerId = "anthropic" as const;

  async *stream(params: StreamParams): AsyncIterable<StreamChunk> {
    const { prompt, historySystem, abortController } = buildPrompt(params);

    const systemPrompt = [params.system, historySystem].filter(Boolean).join("\n\n");

    const options: Options = {
      model: params.modelName,
      tools: [],
      includePartialMessages: true,
      abortController,
      ...(systemPrompt ? { systemPrompt } : {}),
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
            if (delta) {
              yield { type: "text-delta", delta };
              lastEmittedTextLen += delta.length;
            }
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
  historySystem?: string;
  abortController: AbortController;
} {
  // The Agent SDK takes a single user-turn prompt. For multi-turn chats we
  // pass the latest user turn as the prompt and stash the prior transcript in
  // the system prompt under XML-style tags. This avoids inline "User:" /
  // "Assistant:" prefixes that some models echo back as part of the answer.
  const abortController = new AbortController();
  if (params.signal.aborted) abortController.abort();
  else params.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  if (params.messages.length === 0) {
    return { prompt: "", abortController };
  }

  // The current user turn is the last user-role message; anything after it is
  // unexpected for this adapter, but we tolerate it by treating the very last
  // message as the prompt regardless of role.
  let promptIdx = -1;
  for (let i = params.messages.length - 1; i >= 0; i--) {
    if (params.messages[i].role === "user") {
      promptIdx = i;
      break;
    }
  }
  if (promptIdx === -1) promptIdx = params.messages.length - 1;

  const prompt = contentToText(params.messages[promptIdx].content);

  const priorTurns = params.messages
    .slice(0, promptIdx)
    .filter((m) => m.role !== "system");

  if (priorTurns.length === 0) {
    return { prompt, abortController };
  }

  const transcript = priorTurns
    .map((m) => `<turn role="${m.role}">\n${contentToText(m.content)}\n</turn>`)
    .join("\n");
  const historySystem =
    "Prior conversation history is provided below for context. The user's " +
    "current message is in the prompt; respond to it directly, not by " +
    "narrating or quoting the transcript.\n\n" +
    `<conversation>\n${transcript}\n</conversation>`;

  return { prompt, historySystem, abortController };
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
