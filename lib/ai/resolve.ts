import {
  getModelOrThrow,
  type AnimationModelDescriptor,
  type AudioModelDescriptor,
  type ImageModelDescriptor,
  type ModelDescriptor,
  type TextModelDescriptor,
} from "./catalog";
import { anthropicAgentProvider } from "./providers/anthropic-agent";
import {
  comfyUIAnimationProvider,
  comfyUIAudioProvider,
  comfyUIProvider,
} from "./providers/comfyui";
import { googleProvider } from "./providers/google";
import { vercelOllamaProvider } from "./providers/vercel-ollama";
import type {
  AnimationProvider,
  AudioProvider,
  ChatProvider,
  ImageProvider,
} from "./types";

export type ResolvedTextModel = {
  descriptor: TextModelDescriptor;
  provider: ChatProvider;
};

export type ResolvedImageModel = {
  descriptor: ImageModelDescriptor;
  provider: ImageProvider;
};

export type ResolvedAnimationModel = {
  descriptor: AnimationModelDescriptor;
  provider: AnimationProvider;
};

export type ResolvedAudioModel = {
  descriptor: AudioModelDescriptor;
  provider: AudioProvider;
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
    case "google":
      return { descriptor, provider: googleProvider };
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

export function resolveAnimationModel(modelId: string): ResolvedAnimationModel {
  const descriptor: ModelDescriptor = getModelOrThrow(modelId);
  if (descriptor.kind !== "animation") {
    throw new Error(
      `Model "${modelId}" is not an animation model; use resolveModel or resolveImageModel instead.`,
    );
  }
  switch (descriptor.providerId) {
    case "comfyui":
      return { descriptor, provider: comfyUIAnimationProvider };
    default:
      throw new Error(
        `Animation provider "${descriptor.providerId}" is not wired up yet (model ${modelId}).`,
      );
  }
}

export function resolveAudioModel(modelId: string): ResolvedAudioModel {
  const descriptor: ModelDescriptor = getModelOrThrow(modelId);
  if (descriptor.kind !== "audio") {
    throw new Error(
      `Model "${modelId}" is not an audio model; use resolveModel, resolveImageModel, or resolveAnimationModel instead.`,
    );
  }
  switch (descriptor.providerId) {
    case "comfyui":
      return { descriptor, provider: comfyUIAudioProvider };
    default:
      throw new Error(
        `Audio provider "${descriptor.providerId}" is not wired up yet (model ${modelId}).`,
      );
  }
}
