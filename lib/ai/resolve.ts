import { getModelOrThrow, type ModelDescriptor } from "./catalog";
import { anthropicAgentProvider } from "./providers/anthropic-agent";
import { vercelOllamaProvider } from "./providers/vercel-ollama";
import type { ChatProvider } from "./types";

export type ResolvedModel = {
  descriptor: ModelDescriptor;
  provider: ChatProvider;
};

export function resolveModel(modelId: string): ResolvedModel {
  const descriptor = getModelOrThrow(modelId);
  switch (descriptor.providerId) {
    case "anthropic":
      return { descriptor, provider: anthropicAgentProvider };
    case "ollama":
      return { descriptor, provider: vercelOllamaProvider };
    default:
      throw new Error(
        `Provider "${descriptor.providerId}" is not wired up yet (model ${modelId}).`,
      );
  }
}
