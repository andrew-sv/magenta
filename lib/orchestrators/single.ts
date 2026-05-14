import { resolveModel } from "@/lib/ai/resolve";
import type { ChatMessage } from "@/lib/ai/types";
import {
  endRun,
  insertMessage,
  listMessages,
  startRun,
  updateMessage,
} from "@/lib/db/queries";
import type { SingleEvent } from "@/lib/sse/events";
import type { Emit } from "@/lib/sse/writer";

export type SingleParams = {
  conversationId: string;
  modelId: string;
  userContent: string;
};

export async function runSingle(
  params: SingleParams,
  emit: Emit<SingleEvent>,
  signal: AbortSignal,
): Promise<void> {
  const { descriptor, provider } = resolveModel(params.modelId);

  const run = await startRun({ conversationId: params.conversationId, mode: "single" });

  // Persist the user turn first so it's part of history if we crash later.
  await insertMessage({
    conversationId: params.conversationId,
    role: "user",
    content: params.userContent,
    status: "complete",
  });

  const assistant = await insertMessage({
    conversationId: params.conversationId,
    role: "assistant",
    modelId: params.modelId,
    content: "",
    status: "streaming",
  });

  // Build history *after* the user message insert so it's included.
  const history = await listMessages(params.conversationId);
  const chatHistory: ChatMessage[] = history
    .filter((m) => m.id !== assistant.id && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

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
