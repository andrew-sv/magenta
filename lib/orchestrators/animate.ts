import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAnimationModel } from "@/lib/ai/resolve";
import {
  endRun,
  insertMessage,
  startRun,
  updateMessage,
  upsertUserMessage,
} from "@/lib/db/queries";
import type { MessageAttachment } from "@/lib/db/schema";
import type { AnimateEvent } from "@/lib/sse/events";
import type { Emit } from "@/lib/sse/writer";

const PUBLIC_GENERATED_DIR = join(process.cwd(), "public", "generated");

export type AnimateParams = {
  conversationId: string;
  modelId: string;
  tileKey: string;
  clientMessageId: string;
  prompt: string;
  negativePrompt?: string;
  /** Motion strength multiplier — the preset's defining knob. */
  motionScale: number;
  width?: number;
  height?: number;
  steps?: number;
  frames?: number;
  fps?: number;
  seed?: number;
};

export async function runAnimate(
  params: AnimateParams,
  emit: Emit<AnimateEvent>,
  signal: AbortSignal,
): Promise<void> {
  const { descriptor, provider } = resolveAnimationModel(params.modelId);
  const defaults = descriptor.defaults;

  const run = await startRun({
    conversationId: params.conversationId,
    mode: "animate",
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
    type: "animate.tile.meta",
    tileKey: params.tileKey,
    modelId: params.modelId,
    motionScale: params.motionScale,
    userMessageId: userMsg.id,
    assistantMessageId: assistant.id,
  });

  const width = params.width ?? defaults.width;
  const height = params.height ?? defaults.height;
  const steps = params.steps ?? defaults.steps;
  const cfg = defaults.cfg ?? 7.5;
  const frames = params.frames ?? defaults.frames;
  const fps = params.fps ?? defaults.fps;

  const attachments: MessageAttachment[] = [];
  let aborted = false;

  try {
    for await (const ev of provider.generate({
      modelName: descriptor.modelName,
      workflow: descriptor.workflow,
      motionModule: descriptor.motionModule,
      motionScale: params.motionScale,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      width,
      height,
      steps,
      cfg,
      frames,
      fps,
      seed: params.seed,
      signal,
    })) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      if (ev.type === "queued") {
        emit({ type: "animate.queued", position: ev.position });
      } else if (ev.type === "progress") {
        emit({
          type: "animate.progress",
          current: ev.current,
          total: ev.total,
        });
      } else if (ev.type === "gif") {
        const dir = join(PUBLIC_GENERATED_DIR, params.conversationId);
        await mkdir(dir, { recursive: true });
        const suffix = attachments.length === 0 ? "" : `-${attachments.length}`;
        const filename = `${assistant.id}${suffix}.gif`;
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
          type: "animate.gif",
          path: relPath,
          mime: ev.mime,
          width: ev.width,
          height: ev.height,
          frames: ev.frames,
          fps: ev.fps,
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

  if (attachments.length === 0) {
    const message = "no GIF returned by provider";
    await updateMessage(assistant.id, {
      content: params.prompt,
      status: "error",
      attachments,
    });
    await endRun(run.id, "error", message);
    emit({ type: "error", message });
    return;
  }

  await updateMessage(assistant.id, {
    content: params.prompt,
    status: "complete",
    attachments,
  });
  await endRun(run.id, "complete");
}
