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

// ---------- Animation generation ----------

export type AnimationGenParams = {
  modelName: string;
  workflow: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  cfg?: number;
  seed?: number;
  /** Total frames in the clip. */
  frames: number;
  /** Playback frame rate. */
  fps: number;
  /** AnimateDiff motion module file (e.g. mm_sd_v15_v2.ckpt). */
  motionModule: string;
  /** Motion strength multiplier (typically 0.0 - 2.0). */
  motionScale: number;
  signal: AbortSignal;
};

export type AnimationEvent =
  | { type: "queued"; position: number }
  | { type: "progress"; current: number; total: number }
  | {
      type: "gif";
      mime: "image/gif";
      dataBase64: string;
      width?: number;
      height?: number;
      frames?: number;
      fps?: number;
      seed?: number;
    };

export interface AnimationProvider {
  readonly providerId: ProviderId;
  generate(params: AnimationGenParams): AsyncIterable<AnimationEvent>;
}

// ---------- Audio (music) generation ----------

export type AudioGenParams = {
  modelName: string;
  workflow: string;
  /** Style/genre/instrument/mood description (ACE-Step "tags", Stable Audio prompt). */
  prompt: string;
  /** Lyrics for sung output. Empty string yields an instrumental. */
  lyrics?: string;
  negativePrompt?: string;
  /** Target clip length in seconds. */
  durationSeconds: number;
  steps: number;
  cfg?: number;
  seed?: number;
  signal: AbortSignal;
};

export type AudioEvent =
  | { type: "queued"; position: number }
  | { type: "progress"; current: number; total: number }
  | {
      type: "audio";
      /** e.g. "audio/flac", "audio/mpeg". */
      mime: string;
      dataBase64: string;
      durationSeconds?: number;
      seed?: number;
    };

export interface AudioProvider {
  readonly providerId: ProviderId;
  generate(params: AudioGenParams): AsyncIterable<AudioEvent>;
}
