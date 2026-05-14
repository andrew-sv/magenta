import { asc, eq } from "drizzle-orm";
import { resolveModel } from "@/lib/ai/resolve";
import type { ChatMessage } from "@/lib/ai/types";
import { db } from "@/lib/db/client";
import { messages } from "@/lib/db/schema";
import {
  endRun,
  insertMessage,
  startRun,
  updateMessage,
  upsertUserMessage,
} from "@/lib/db/queries";
import type { FanoutEvent } from "@/lib/sse/events";
import type { Emit } from "@/lib/sse/writer";

export type FanoutParams = {
  conversationId: string;
  modelId: string;
  paneKey: string;
  clientMessageId: string;
  userContent: string;
};

export async function runFanout(
  params: FanoutParams,
  emit: Emit<FanoutEvent>,
  signal: AbortSignal,
): Promise<void> {
  const { descriptor, provider } = resolveModel(params.modelId);

  const run = await startRun({ conversationId: params.conversationId, mode: "fanout" });

  const userMsg = await upsertUserMessage({
    conversationId: params.conversationId,
    role: "user",
    content: params.userContent,
    status: "complete",
    clientMessageId: params.clientMessageId,
  });

  const assistant = await insertMessage({
    conversationId: params.conversationId,
    role: "assistant",
    modelId: params.modelId,
    paneKey: params.paneKey,
    parentId: userMsg.id,
    content: "",
    status: "streaming",
  });

  emit({
    type: "pane.meta",
    paneKey: params.paneKey,
    modelId: params.modelId,
    userMessageId: userMsg.id,
    assistantMessageId: assistant.id,
  });

  // Build this pane's own history: only user turns (shared) and this pane's prior assistant turns.
  const priorRows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.conversationId))
    .orderBy(asc(messages.createdAt));

  const chatHistory: ChatMessage[] = [];
  for (const row of priorRows) {
    if (row.id === assistant.id) continue;
    if (row.role === "user") {
      chatHistory.push({ role: "user", content: row.content });
    } else if (row.role === "assistant" && row.paneKey === params.paneKey) {
      chatHistory.push({ role: "assistant", content: row.content });
    }
  }

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

