import type { ProviderId } from "./types";

type BaseModelDescriptor = {
  id: string;
  label: string;
  providerId: ProviderId;
  modelName: string;
};

export type TextModelDescriptor = BaseModelDescriptor & {
  kind: "text";
  contextWindow: number;
  capabilities: {
    streaming: boolean;
    structuredOutput: boolean;
  };
};

export type ImageModelDescriptor = BaseModelDescriptor & {
  kind: "image";
  /** Name of the workflow template under lib/ai/workflows/. */
  workflow: string;
  defaults: {
    width: number;
    height: number;
    steps: number;
    cfg?: number;
  };
};

export type ModelDescriptor = TextModelDescriptor | ImageModelDescriptor;

/**
 * The static catalog of models the UI can show. Availability of individual
 * Ollama models is resolved at request time against `/api/tags`; Claude
 * availability is gated on `claude login` having been run; ComfyUI image
 * models are gated on the local server reporting the checkpoint in
 * `/object_info/CheckpointLoaderSimple`.
 *
 * Add entries here when adding a model. The id must be unique and follow
 * "<providerId>:<modelName>".
 */
export const MODEL_CATALOG: readonly ModelDescriptor[] = [
  {
    id: "anthropic:claude-opus-4-7",
    label: "Claude Opus 4.7",
    providerId: "anthropic",
    modelName: "claude-opus-4-7",
    kind: "text",
    contextWindow: 200_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "anthropic:claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    providerId: "anthropic",
    modelName: "claude-sonnet-4-6",
    kind: "text",
    contextWindow: 200_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "anthropic:claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    providerId: "anthropic",
    modelName: "claude-haiku-4-5-20251001",
    kind: "text",
    contextWindow: 200_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "google:gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    providerId: "google",
    modelName: "gemini-2.5-flash",
    kind: "text",
    contextWindow: 1_048_576,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "google:gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    providerId: "google",
    modelName: "gemini-2.5-flash-lite",
    kind: "text",
    contextWindow: 1_048_576,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "google:gemini-3-flash-preview",
    label: "Gemini 3 Flash (preview)",
    providerId: "google",
    modelName: "gemini-3-flash-preview",
    kind: "text",
    contextWindow: 1_048_576,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:llama3.1",
    label: "Llama 3.1 8B (Ollama)",
    providerId: "ollama",
    modelName: "llama3.1",
    kind: "text",
    contextWindow: 128_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:gpt-oss",
    label: "GPT-OSS 20B (Ollama)",
    providerId: "ollama",
    modelName: "gpt-oss",
    kind: "text",
    contextWindow: 128_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:gemma4:26b",
    label: "Gemma 4 26B (Ollama)",
    providerId: "ollama",
    modelName: "gemma4:26b",
    kind: "text",
    contextWindow: 128_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:deepseek-r1:14b",
    label: "DeepSeek-R1 14B (Ollama)",
    providerId: "ollama",
    modelName: "deepseek-r1:14b",
    kind: "text",
    contextWindow: 128_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:qwen2.5-coder:14b",
    label: "Qwen2.5 Coder 14B (Ollama)",
    providerId: "ollama",
    modelName: "qwen2.5-coder:14b",
    kind: "text",
    contextWindow: 32_768,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:qwen2.5vl",
    label: "Qwen2.5-VL 7B (Ollama, vision)",
    providerId: "ollama",
    modelName: "qwen2.5vl",
    kind: "text",
    contextWindow: 128_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:XTeMixX/x-ai",
    label: "x-ai 7B (Ollama, community)",
    providerId: "ollama",
    modelName: "XTeMixX/x-ai",
    kind: "text",
    contextWindow: 32_768,
    capabilities: { streaming: true, structuredOutput: false },
  },
  {
    id: "comfyui:sdxl-turbo",
    label: "SDXL Turbo (ComfyUI)",
    providerId: "comfyui",
    modelName: "sd_xl_turbo_1.0_fp16.safetensors",
    kind: "image",
    workflow: "sdxl-turbo",
    defaults: { width: 1024, height: 1024, steps: 4, cfg: 1 },
  },
  {
    id: "comfyui:flux-schnell",
    label: "FLUX.1 schnell fp8 (ComfyUI)",
    providerId: "comfyui",
    modelName: "flux1-schnell-fp8.safetensors",
    kind: "image",
    workflow: "flux-schnell",
    defaults: { width: 1024, height: 1024, steps: 4, cfg: 1 },
  },
] as const;

export function findModel(id: string): ModelDescriptor | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function getModelOrThrow(id: string): ModelDescriptor {
  const m = findModel(id);
  if (!m) throw new Error(`Unknown model id: ${id}`);
  return m;
}
