import {
  getModelOrThrow,
  type ImageModelDescriptor,
  type ModelDescriptor,
  type TextModelDescriptor,
} from "./catalog";
import { anthropicAgentProvider } from "./providers/anthropic-agent";
import { comfyUIProvider } from "./providers/comfyui";
import { vercelOllamaProvider } from "./providers/vercel-ollama";
import type { ChatProvider, ImageProvider } from "./types";

export type ResolvedTextModel = {
  descriptor: TextModelDescriptor;
  provider: ChatProvider;
};

export type ResolvedImageModel = {
  descriptor: ImageModelDescriptor;
  provider: ImageProvider;
};

export type ResolvedModel = ResolvedTextModel;

export function resolveModel(modelId: string): ResolvedTextModel {
  const descriptor: ModelDescriptor = getModelOrThrow(modelId);
  if (descriptor.kind !== "text") {
    throw new Error(
      `Model "${modelId}" is an image model; use resolveImageModel instead.`,
    );
  }
  switch (descriptor.providerId) {
    case "anthropic":
      return { descriptor, provider: anthropicAgentProvider };
    case "ollama":
      return { descriptor, provider: vercelOllamaProvider };
    default:
      throw new Error(
        `Text provider "${descriptor.providerId}" is not wired up yet (model ${modelId}).`,
      );
  }
}

export function resolveImageModel(modelId: string): ResolvedImageModel {
  const descriptor: ModelDescriptor = getModelOrThrow(modelId);
  if (descriptor.kind !== "image") {
    throw new Error(
      `Model "${modelId}" is a text model; use resolveModel instead.`,
    );
  }
  switch (descriptor.providerId) {
    case "comfyui":
      return { descriptor, provider: comfyUIProvider };
    default:
      throw new Error(
        `Image provider "${descriptor.providerId}" is not wired up yet (model ${modelId}).`,
      );
  }
}
