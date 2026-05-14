import type { z } from "zod";

export type Role = "user" | "assistant" | "system";

export type ChatMessage = {
  role: Role;
  content: string;
};

export type StreamChunk = { type: "text-delta"; delta: string };

export type StreamParams = {
  modelName: string;
  messages: ChatMessage[];
  system?: string;
  signal: AbortSignal;
};

export type GenerateObjectParams<T> = {
  modelName: string;
  messages: ChatMessage[];
  system?: string;
  schema: z.ZodType<T>;
  signal: AbortSignal;
};

export interface ChatProvider {
  readonly providerId: ProviderId;
  stream(params: StreamParams): AsyncIterable<StreamChunk>;
  /** Returns null on irrecoverable parse/validation failure (caller handles fallback). */
  generateObject<T>(params: GenerateObjectParams<T>): Promise<T | null>;
}

export const PROVIDER_IDS = ["anthropic", "ollama", "openai", "google", "xai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
