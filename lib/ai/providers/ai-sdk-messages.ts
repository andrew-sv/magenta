import type { ImagePart as AiImagePart, ModelMessage, TextPart as AiTextPart } from "ai";
import type { ChatMessage, ContentPart } from "../types";

/**
 * Maps our internal `ChatMessage[]` to the Vercel AI SDK's `ModelMessage[]`.
 * Shared by the Google and Ollama adapters.
 *
 * Image parts are only valid on user turns in the AI SDK, so for system and
 * assistant turns we flatten multimodal content down to its text.
 */
export function toModelMessages(
  messages: ChatMessage[],
  system?: string,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content } as ModelMessage);
      continue;
    }

    if (m.role === "user") {
      out.push({ role: "user", content: m.content.map(toAiSdkPart) });
    } else {
      out.push({ role: m.role, content: flattenText(m.content) } as ModelMessage);
    }
  }

  return out;
}

function toAiSdkPart(part: ContentPart): AiTextPart | AiImagePart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  return { type: "image", image: part.image, mediaType: part.mediaType };
}

function flattenText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}
