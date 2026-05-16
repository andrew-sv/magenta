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

export const PROVIDER_IDS = [
  "anthropic",
  "ollama",
  "openai",
  "google",
  "xai",
  "comfyui",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

// ---------- Image generation ----------

export type ImageGenParams = {
  modelName: string;
  workflow: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  cfg?: number;
  seed?: number;
  signal: AbortSignal;
};

export type ImageEvent =
  | { type: "queued"; position: number }
  | { type: "progress"; current: number; total: number }
  | { type: "preview"; mime: string; dataBase64: string }
  | {
      type: "image";
      mime: string;
      dataBase64: string;
      width?: number;
      height?: number;
      seed?: number;
    };

export interface ImageProvider {
  readonly providerId: ProviderId;
  generate(params: ImageGenParams): AsyncIterable<ImageEvent>;
}
