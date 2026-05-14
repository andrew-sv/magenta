import { generateObject, streamText, type LanguageModel, type ModelMessage } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { env } from "../../env";
import type {
  ChatProvider,
  GenerateObjectParams,
  StreamChunk,
  StreamParams,
} from "../types";

const ollama = createOllama({ baseURL: `${env.OLLAMA_BASE_URL}/api` });

function resolve(modelName: string): LanguageModel {
  return ollama(modelName);
}

function toModelMessages(
  messages: StreamParams["messages"],
  system?: string,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    out.push({ role: m.role, content: m.content } as ModelMessage);
  }
  return out;
}

class VercelOllamaProvider implements ChatProvider {
  readonly providerId = "ollama" as const;

  async *stream(params: StreamParams): AsyncIterable<StreamChunk> {
    const result = streamText({
      model: resolve(params.modelName),
      messages: toModelMessages(params.messages, params.system),
      abortSignal: params.signal,
    });

    for await (const delta of result.textStream) {
      if (params.signal.aborted) break;
      if (delta) yield { type: "text-delta", delta };
    }
  }

  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (params.signal.aborted) return null;
      try {
        const { object } = await generateObject({
          model: resolve(params.modelName),
          schema: params.schema,
          messages: toModelMessages(params.messages, params.system),
          abortSignal: params.signal,
        });
        return object as T;
      } catch (err) {
        if (params.signal.aborted) return null;
        if (attempt === 2) {
          // Surface to caller only if there was no valid output across all retries.
          if (env.NODE_ENV !== "production") {
            console.warn(`[vercel-ollama] generateObject failed after retries:`, err);
          }
          return null;
        }
      }
    }
    return null;
  }
}

export const vercelOllamaProvider = new VercelOllamaProvider();
