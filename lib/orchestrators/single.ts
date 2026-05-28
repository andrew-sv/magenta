import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveModel } from "@/lib/ai/resolve";
import type { ChatMessage, ContentPart } from "@/lib/ai/types";
import {
  endRun,
  insertMessage,
  listMessages,
  startRun,
  updateMessage,
} from "@/lib/db/queries";
import type { Message, MessageAttachment } from "@/lib/db/schema";
import type { SingleEvent } from "@/lib/sse/events";
import type { Emit } from "@/lib/sse/writer";

const PUBLIC_UPLOADS_DIR = join(process.cwd(), "public", "uploads");

export type SingleParams = {
  conversationId: string;
  modelId: string;
  userContent: string;
  images?: { dataBase64: string; mime: string }[];
};

export async function runSingle(
  params: SingleParams,
  emit: Emit<SingleEvent>,
  signal: AbortSignal,
): Promise<void> {
  const { descriptor, provider } = resolveModel(params.modelId);

  const run = await startRun({ conversationId: params.conversationId, mode: "single" });

  // Persist the user turn first so it's part of history if we crash later.
  const userMsg = await insertMessage({
    conversationId: params.conversationId,
    role: "user",
    content: params.userContent,
    status: "complete",
  });

  // Save any uploaded images to disk and attach them to the user message so
  // they survive reloads and feed back into multi-turn history.
  if (params.images?.length) {
    const attachments = await saveImages(
      params.conversationId,
      userMsg.id,
      params.images,
    );
    await updateMessage(userMsg.id, { attachments });
  }

  const assistant = await insertMessage({
    conversationId: params.conversationId,
    role: "assistant",
    modelId: params.modelId,
    content: "",
    status: "streaming",
  });

  // Build history *after* the user message insert so it's included. Image parts
  // are only sent to vision-capable models; otherwise we fall back to text.
  const history = await listMessages(params.conversationId);
  const chatHistory: ChatMessage[] = await Promise.all(
    history
      .filter((m) => m.id !== assistant.id && (m.role === "user" || m.role === "assistant"))
      .map(async (m) => ({
        role: m.role as "user" | "assistant",
        content:
          m.role === "user" && descriptor.capabilities.vision
            ? await toUserContent(m)
            : m.content,
      })),
  );

  let acc = "";
  let aborted = false;

  try {
    for await (const chunk of provider.stream({
      modelName: descriptor.modelName,
      messages: chatHistory,
      signal,
    })) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      acc += chunk.delta;
      emit({ type: "token", delta: chunk.delta });
    }
  } catch (err) {
    await updateMessage(assistant.id, { content: acc, status: "error" });
    await endRun(run.id, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }

  if (aborted) {
    await updateMessage(assistant.id, { content: acc, status: "aborted" });
    await endRun(run.id, "aborted");
    return;
  }

  await updateMessage(assistant.id, { content: acc, status: "complete" });
  await endRun(run.id, "complete");
  emit({ type: "message.complete", messageId: assistant.id });
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

async function saveImages(
  conversationId: string,
  messageId: string,
  images: { dataBase64: string; mime: string }[],
): Promise<MessageAttachment[]> {
  const dir = join(PUBLIC_UPLOADS_DIR, conversationId);
  await mkdir(dir, { recursive: true });
  const out: MessageAttachment[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = MIME_EXT[img.mime] ?? ".png";
    const filename = `${messageId}-${i}${ext}`;
    await writeFile(join(dir, filename), Buffer.from(img.dataBase64, "base64"));
    out.push({
      kind: "image",
      path: `/uploads/${conversationId}/${filename}`,
      mime: img.mime,
    });
  }
  return out;
}

/**
 * Builds a multimodal user turn from a stored message: text plus any image
 * attachments, read back from disk and base64-encoded for the provider.
 */
async function toUserContent(m: Message): Promise<ChatMessage["content"]> {
  const imgs = m.attachments.filter((a) => a.kind === "image");
  if (imgs.length === 0) return m.content;

  const parts: ContentPart[] = [];
  if (m.content.trim()) parts.push({ type: "text", text: m.content });
  for (const a of imgs) {
    const abs = join(process.cwd(), "public", a.path.replace(/^\//, ""));
    const buf = await readFile(abs);
    parts.push({ type: "image", image: buf.toString("base64"), mediaType: a.mime });
  }
  return parts;
}
