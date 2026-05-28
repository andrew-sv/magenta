import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAudioModel } from "@/lib/ai/resolve";
import {
  endRun,
  insertMessage,
  startRun,
  updateMessage,
  upsertUserMessage,
} from "@/lib/db/queries";
import type { MessageAttachment } from "@/lib/db/schema";
import type { MusicEvent } from "@/lib/sse/events";
import type { Emit } from "@/lib/sse/writer";

const PUBLIC_GENERATED_DIR = join(process.cwd(), "public", "generated");

const EXT_BY_MIME: Record<string, string> = {
  "audio/flac": "flac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/opus": "opus",
  "audio/ogg": "ogg",
};

export type MusicParams = {
  conversationId: string;
  modelId: string;
  tileKey: string;
  clientMessageId: string;
  /** Style/genre/mood description. */
  prompt: string;
  /** Lyrics to sing; ignored by instrumental models. */
  lyrics?: string;
  negativePrompt?: string;
  durationSeconds?: number;
  steps?: number;
  seed?: number;
};

export async function runMusic(
  params: MusicParams,
  emit: Emit<MusicEvent>,
  signal: AbortSignal,
): Promise<void> {
  const { descriptor, provider } = resolveAudioModel(params.modelId);
  const defaults = descriptor.defaults;

  const run = await startRun({
    conversationId: params.conversationId,
    mode: "music",
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
    type: "music.tile.meta",
    tileKey: params.tileKey,
    modelId: params.modelId,
    userMessageId: userMsg.id,
    assistantMessageId: assistant.id,
  });

  const durationSeconds = params.durationSeconds ?? defaults.durationSeconds;
  const steps = params.steps ?? defaults.steps;
  const cfg = defaults.cfg ?? 5;

  const attachments: MessageAttachment[] = [];
  let aborted = false;

  try {
    for await (const ev of provider.generate({
      modelName: descriptor.modelName,
      workflow: descriptor.workflow,
      prompt: params.prompt,
      lyrics: descriptor.supportsLyrics ? params.lyrics : undefined,
      negativePrompt: params.negativePrompt,
      durationSeconds,
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
        emit({ type: "music.queued", position: ev.position });
      } else if (ev.type === "progress") {
        emit({ type: "music.progress", current: ev.current, total: ev.total });
      } else if (ev.type === "audio") {
        const dir = join(PUBLIC_GENERATED_DIR, params.conversationId);
        await mkdir(dir, { recursive: true });
        const ext = EXT_BY_MIME[ev.mime] ?? "bin";
        const suffix = attachments.length === 0 ? "" : `-${attachments.length}`;
        const filename = `${assistant.id}${suffix}.${ext}`;
        const absPath = join(dir, filename);
        const relPath = `/generated/${params.conversationId}/${filename}`;
        await writeFile(absPath, Buffer.from(ev.dataBase64, "base64"));
        attachments.push({
          kind: "audio",
          path: relPath,
          mime: ev.mime,
          durationSeconds: ev.durationSeconds,
          modelId: params.modelId,
          prompt: params.prompt,
        });
        emit({
          type: "music.audio",
          path: relPath,
          mime: ev.mime,
          durationSeconds: ev.durationSeconds,
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
    const message = "no audio returned by provider";
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
