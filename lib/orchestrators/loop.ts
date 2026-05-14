import { resolveModel } from "@/lib/ai/resolve";
import type { ChatMessage } from "@/lib/ai/types";
import { env } from "@/lib/env";
import {
  endRun,
  insertMessage,
  startRun,
  updateMessage,
} from "@/lib/db/queries";
import type { LoopEvent } from "@/lib/sse/events";
import type { Emit } from "@/lib/sse/writer";

export type LoopParams = {
  conversationId: string;
  modelAId: string;
  modelBId: string;
  userContent: string;
  maxRounds?: number;
  /** Max prior turns retained in each model's context. */
  contextWindow?: number;
};

const B_QUESTION_SYSTEM =
  "You are facilitating a probing follow-up conversation. " +
  "Given the previous answer, ask exactly one short follow-up question that surfaces the most important uncertainty, " +
  "edge case, or missing detail. Output only the question. No preamble, no markdown.";

export async function runLoop(
  params: LoopParams,
  emit: Emit<LoopEvent>,
  signal: AbortSignal,
): Promise<void> {
  const a = resolveModel(params.modelAId);
  const b = resolveModel(params.modelBId);
  const maxRounds = params.maxRounds ?? env.DEFAULT_LOOP_ROUNDS;
  const contextWindow = params.contextWindow ?? 6;

  const run = await startRun({ conversationId: params.conversationId, mode: "loop" });

  await insertMessage({
    conversationId: params.conversationId,
    role: "user",
    content: params.userContent,
    status: "complete",
    round: 0,
  });

  // Running transcript shared between A and B. A reads it as-is (user/assistant
  // alternation). B reads it with roles flipped so A's answers look like "user"
  // input to B — see callers' `messagesForB`.
  const transcript: ChatMessage[] = [{ role: "user", content: params.userContent }];

  // Round 0: A answers the user's seed prompt.
  const okSeed = await runTurn({
    label: "A",
    round: 0,
    modelId: params.modelAId,
    descriptorName: a.descriptor.modelName,
    provider: a.provider,
    messages: clip(transcript, contextWindow),
    conversationId: params.conversationId,
    emit,
    signal,
    transcript,
    pushAs: "assistant",
  });
  if (!okSeed) {
    await endRun(run.id, signal.aborted ? "aborted" : "complete");
    if (signal.aborted) emit({ type: "aborted" });
    return;
  }

  let completedRounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (signal.aborted) break;

    // B asks a follow-up. From B's perspective, A's prior answers look like prompts.
    const messagesForB = flipForB(transcript);
    const okB = await runTurn({
      label: "B",
      round,
      modelId: params.modelBId,
      descriptorName: b.descriptor.modelName,
      provider: b.provider,
      messages: clip(messagesForB, contextWindow),
      system: B_QUESTION_SYSTEM,
      conversationId: params.conversationId,
      emit,
      signal,
      transcript,
      // B's question becomes the next user turn from A's perspective.
      pushAs: "user",
    });
    if (!okB) break;

    // A answers B's question.
    const okA = await runTurn({
      label: "A",
      round,
      modelId: params.modelAId,
      descriptorName: a.descriptor.modelName,
      provider: a.provider,
      messages: clip(transcript, contextWindow),
      conversationId: params.conversationId,
      emit,
      signal,
      transcript,
      pushAs: "assistant",
    });
    if (!okA) break;

    completedRounds = round;
  }

  if (signal.aborted) {
    await endRun(run.id, "aborted");
    emit({ type: "aborted" });
    return;
  }

  await endRun(run.id, "complete");
  emit({ type: "loop.complete", rounds: completedRounds });
}

type TurnArgs = {
  label: "A" | "B";
  round: number;
  modelId: string;
  descriptorName: string;
  provider: ReturnType<typeof resolveModel>["provider"];
  messages: ChatMessage[];
  system?: string;
  conversationId: string;
  emit: Emit<LoopEvent>;
  signal: AbortSignal;
  transcript: ChatMessage[];
  pushAs: "user" | "assistant";
};

async function runTurn(args: TurnArgs): Promise<boolean> {
  const row = await insertMessage({
    conversationId: args.conversationId,
    role: "assistant",
    modelId: args.modelId,
    paneKey: args.label,
    round: args.round,
    content: "",
    status: "streaming",
  });

  args.emit({
    type: "turn.start",
    turnId: row.id,
    role: args.label,
    round: args.round,
    modelId: args.modelId,
  });

  let acc = "";
  try {
    for await (const chunk of args.provider.stream({
      modelName: args.descriptorName,
      messages: args.messages,
      system: args.system,
      signal: args.signal,
    })) {
      if (args.signal.aborted) break;
      acc += chunk.delta;
      args.emit({ type: "token", turnId: row.id, delta: chunk.delta });
    }
  } catch (err) {
    await updateMessage(row.id, { content: acc, status: "error" });
    throw err;
  }

  if (args.signal.aborted) {
    await updateMessage(row.id, { content: acc, status: "aborted" });
    return false;
  }

  await updateMessage(row.id, { content: acc, status: "complete" });
  args.emit({ type: "turn.complete", turnId: row.id });
  args.transcript.push({ role: args.pushAs, content: acc });
  return true;
}

function clip(history: ChatMessage[], maxTurns: number): ChatMessage[] {
  if (history.length <= maxTurns) return history;
  return history.slice(history.length - maxTurns);
}

/**
 * Re-roles the transcript so that from B's view, A's prior answers look like
 * user prompts and B's prior questions look like assistant outputs. The seed
 * user prompt is dropped — B should be reacting to A's last answer, not the
 * original question (otherwise B tends to repeat the user verbatim).
 */
function flipForB(transcript: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // Skip index 0 (the seed user prompt).
  for (let i = 1; i < transcript.length; i++) {
    const m = transcript[i];
    out.push({ role: m.role === "user" ? "assistant" : "user", content: m.content });
  }
  return out;
}
