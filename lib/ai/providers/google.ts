import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, streamText, type LanguageModel } from "ai";
import { env } from "../../env";
import type {
  ChatProvider,
  GenerateObjectParams,
  StreamChunk,
  StreamParams,
} from "../types";
import { toModelMessages } from "./ai-sdk-messages";

const google = env.GOOGLE_GENERATIVE_AI_API_KEY
  ? createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })
  : null;

function resolve(modelName: string): LanguageModel {
  if (!google) {
    throw new Error(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set — add it to .env to use Gemini models.",
    );
  }
  return google(modelName);
}

class GoogleProvider implements ChatProvider {
  readonly providerId = "google" as const;

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
    console.warn(
      `[google] generateObject(${params.modelName}) failed after 3 attempts:`,
      lastError,
    );
    return null;
  }
}

export const googleProvider = new GoogleProvider();
