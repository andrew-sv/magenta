import { generateObject, streamText, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { env } from "../../env";
import type {
  ChatProvider,
  GenerateObjectParams,
  StreamChunk,
  StreamParams,
} from "../types";
import { toModelMessages } from "./ai-sdk-messages";

const ollama = createOllama({ baseURL: `${env.OLLAMA_BASE_URL}/api` });

function resolve(modelName: string): LanguageModel {
  return ollama(modelName);
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
    let lastError: unknown = null;
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
        lastError = err;
      }
    }
    // All retries exhausted. Log so the failure isn't silent — the caller
    // already handles `null` as "scorer produced invalid output".
    console.warn(
      `[vercel-ollama] generateObject(${params.modelName}) failed after 3 attempts:`,
      lastError,
    );
    return null;
  }
}

export const vercelOllamaProvider = new VercelOllamaProvider();
