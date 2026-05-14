import type { ProviderId } from "./types";

export type ModelDescriptor = {
  id: string;
  label: string;
  providerId: ProviderId;
  modelName: string;
  contextWindow: number;
  capabilities: {
    streaming: boolean;
    structuredOutput: boolean;
  };
};

/**
 * The static catalog of models the UI can show. Availability of individual
 * Ollama models is resolved at request time against `/api/tags`; Claude
 * availability is gated on `claude login` having been run.
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
    contextWindow: 200_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "anthropic:claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    providerId: "anthropic",
    modelName: "claude-sonnet-4-6",
    contextWindow: 200_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "anthropic:claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    providerId: "anthropic",
    modelName: "claude-haiku-4-5-20251001",
    contextWindow: 200_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:llama3.1",
    label: "Llama 3.1 8B (Ollama)",
    providerId: "ollama",
    modelName: "llama3.1",
    contextWindow: 128_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:deepseek-r1:14b",
    label: "DeepSeek-R1 14B (Ollama)",
    providerId: "ollama",
    modelName: "deepseek-r1:14b",
    contextWindow: 128_000,
    capabilities: { streaming: true, structuredOutput: true },
  },
  {
    id: "ollama:qwen2.5-coder:14b",
    label: "Qwen2.5 Coder 14B (Ollama)",
    providerId: "ollama",
    modelName: "qwen2.5-coder:14b",
    contextWindow: 32_768,
    capabilities: { streaming: true, structuredOutput: true },
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
