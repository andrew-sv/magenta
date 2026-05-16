import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveImageModel } from "@/lib/ai/resolve";
import {
  endRun,
  insertMessage,
  startRun,
  updateMessage,
  upsertUserMessage,
} from "@/lib/db/queries";
import type { MessageAttachment } from "@/lib/db/schema";
import type { ImagineEvent } from "@/lib/sse/events";
import type { Emit } from "@/lib/sse/writer";

const PUBLIC_GENERATED_DIR = join(process.cwd(), "public", "generated");

export type ImagineParams = {
  conversationId: string;
  modelId: string;
  tileKey: string;
  clientMessageId: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
};

export async function runImagine(
  params: ImagineParams,
  emit: Emit<ImagineEvent>,
  signal: AbortSignal,
): Promise<void> {
  const { descriptor, provider } = resolveImageModel(params.modelId);
  const defaults = descriptor.defaults;

  const run = await startRun({
    conversationId: params.conversationId,
    mode: "imagine",
  });

  const userMsg = await upsertUserMessage({
    conversationId: params.conversationId,
    role: "user",
    content: params.prompt,
    status: "complete",
    clientMessageId: params.clientMessageId,
  });

  const assistant = await insertMessage({
    conversationId: params.conversationId,
    role: "assistant",
    modelId: params.modelId,
    paneKey: params.tileKey,
    parentId: userMsg.id,
    content: "",
    status: "streaming",
  });

  emit({
    type: "tile.meta",
    tileKey: params.tileKey,
    modelId: params.modelId,
    userMessageId: userMsg.id,
    assistantMessageId: assistant.id,
  });

  const width = params.width ?? defaults.width;
  const height = params.height ?? defaults.height;
  const steps = params.steps ?? defaults.steps;
  const cfg = defaults.cfg ?? 1;

  const attachments: MessageAttachment[] = [];
  let aborted = false;

  try {
    for await (const ev of provider.generate({
      modelName: descriptor.modelName,
      workflow: descriptor.workflow,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      width,
      height,
      steps,
      cfg,
      seed: params.seed,
      signal,
    })) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      if (ev.type === "queued") {
        emit({ type: "imagine.queued", position: ev.position });
      } else if (ev.type === "progress") {
        emit({
          type: "imagine.progress",
          current: ev.current,
          total: ev.total,
        });
      } else if (ev.type === "preview") {
        emit({
          type: "imagine.preview",
          mime: ev.mime,
          dataBase64: ev.dataBase64,
        });
      } else if (ev.type === "image") {
        const ext = ev.mime === "image/jpeg" ? ".jpg" : ".png";
        const dir = join(PUBLIC_GENERATED_DIR, params.conversationId);
        await mkdir(dir, { recursive: true });
        // Multiple images per assistant message (unlikely but possible with batch_size>1):
        // suffix with attachments.length so we don't clobber.
        const suffix = attachments.length === 0 ? "" : `-${attachments.length}`;
        const filename = `${assistant.id}${suffix}${ext}`;
        const absPath = join(dir, filename);
        const relPath = `/generated/${params.conversationId}/${filename}`;
        await writeFile(absPath, Buffer.from(ev.dataBase64, "base64"));
        attachments.push({
          kind: "image",
          path: relPath,
          mime: ev.mime,
          width: ev.width,
          height: ev.height,
          modelId: params.modelId,
          prompt: params.prompt,
        });
        emit({
          type: "imagine.image",
          path: relPath,
          mime: ev.mime,
          width: ev.width,
          height: ev.height,
          seed: ev.seed,
        });
      }
    }
  } catch (err) {
    await updateMessage(assistant.id, {
      content: params.prompt,
      status: "error",
      attachments,
    });
    await endRun(run.id, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }

  if (aborted) {
    await updateMessage(assistant.id, {
      content: params.prompt,
      status: "aborted",
      attachments,
    });
    await endRun(run.id, "aborted");
    return;
  }

  await updateMessage(assistant.id, {
    content: params.prompt,
    status: "complete",
    attachments,
  });
  await endRun(run.id, "complete");
}
