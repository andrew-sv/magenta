import { z } from "zod";
import { resolveModel, type ResolvedModel } from "@/lib/ai/resolve";
import type { ChatMessage } from "@/lib/ai/types";
import {
  averagesByTarget,
  endRun,
  insertMessage,
  insertScore,
  startRun,
  updateMessage,
} from "@/lib/db/queries";
import type {
  CouncilEvent,
  CouncilMemberCompleteEvent,
  CouncilMemberStartEvent,
  CouncilMemberTokenEvent,
} from "@/lib/sse/events";
import type { Emit } from "@/lib/sse/writer";

export type CouncilParams = {
  conversationId: string;
  memberModelIds: string[];
  userContent: string;
  /**
   * When the council is invoked as a building block of another orchestrator
   * (e.g. synthesis), the caller owns the `runs` row and passes its id here.
   * In that case we don't open or close our own run.
   */
  existingRunId?: string;
};

export type CouncilMemberResult = {
  memberKey: string;
  modelId: string;
  messageId: string;
  content: string;
  status: "complete" | "aborted" | "error";
};

const SCORE_SCHEMA = z.object({
  score: z.number().int().min(0).max(100),
  brief_reason: z.string().max(400).optional(),
});

const SCORER_SYSTEM =
  "You are an impartial evaluator of AI responses. Score the candidate response 0-100 " +
  "for correctness, completeness, and usefulness relative to the original question. " +
  "Return a single JSON object: {\"score\": <int>, \"brief_reason\": <short string>}. " +
  "No prose, no markdown fences. 100 = excellent; 0 = unhelpful or wrong.";

/**
 * Council orchestrator — used directly for Case 4 and as a building block for
 * Case 5 (synthesis). Returns the per-member results so synthesis can chain.
 */
export async function runCouncil(
  params: CouncilParams,
  emit: Emit<CouncilEvent>,
  signal: AbortSignal,
): Promise<{
  results: CouncilMemberResult[];
  averages: Record<string, number | null>;
}> {
  if (params.memberModelIds.length < 2) {
    throw new Error("Council requires at least 2 distinct models.");
  }
  if (new Set(params.memberModelIds).size !== params.memberModelIds.length) {
    throw new Error("Council members must be distinct.");
  }

  const ownsRun = !params.existingRunId;
  const runId =
    params.existingRunId ??
    (await startRun({ conversationId: params.conversationId, mode: "council" })).id;

  // Persist user prompt.
  const userMsg = await insertMessage({
    conversationId: params.conversationId,
    role: "user",
    content: params.userContent,
    status: "complete",
  });

  // Resolve all members up front so a bad id fails fast (before we open streams).
  const resolved: Array<{ key: string; modelId: string; resolved: ResolvedModel }> =
    params.memberModelIds.map((modelId, i) => ({
      key: `member-${i}`,
      modelId,
      resolved: resolveModel(modelId),
    }));

  // Insert a stub assistant message per member, then announce them.
  const members: Array<{
    key: string;
    modelId: string;
    resolved: ResolvedModel;
    messageId: string;
  }> = [];
  for (const m of resolved) {
    const row = await insertMessage({
      conversationId: params.conversationId,
      parentId: userMsg.id,
      role: "assistant",
      modelId: m.modelId,
      paneKey: m.key,
      content: "",
      status: "streaming",
    });
    members.push({ ...m, messageId: row.id });
    const startEvt: CouncilMemberStartEvent = {
      type: "member.start",
      memberKey: m.key,
      modelId: m.modelId,
      messageId: row.id,
    };
    emit(startEvt);
  }

  // Stream all members in parallel. Each task is self-contained, persists its
  // own final state, and emits its own events. Failures are caught so one bad
  // member doesn't kill the council — surfaced via `error` event on that key.
  const memberResults = await Promise.all(
    members.map((m) => streamMember(m, params.userContent, emit, signal)),
  );

  if (signal.aborted) {
    if (ownsRun) await endRun(runId, "aborted");
    return { results: memberResults, averages: {} };
  }

  // Scoring: each member scores every other member (self excluded). Run in
  // parallel; capture per-scorer per-target results.
  emit({ type: "scoring.start" });

  const scorablePairs: Array<{
    scorer: (typeof members)[number];
    target: (typeof members)[number];
    targetResult: CouncilMemberResult;
  }> = [];
  for (const scorer of members) {
    for (let j = 0; j < members.length; j++) {
      const target = members[j];
      if (target.key === scorer.key) continue;
      const targetResult = memberResults[j];
      if (targetResult.status !== "complete" || !targetResult.content) continue;
      scorablePairs.push({ scorer, target, targetResult });
    }
  }

  await Promise.all(
    scorablePairs.map((p) =>
      scoreOne(params, userMsg.id, p.scorer, p.target, p.targetResult, emit, signal),
    ),
  );

  const averages = await averagesByTarget(params.conversationId);
  // Project averages keyed by target message id → memberKey for the UI.
  const byKey: Record<string, number | null> = {};
  for (const m of members) {
    byKey[m.key] = averages[m.messageId] ?? null;
  }

  emit({ type: "scoring.complete", averages: byKey });

  if (ownsRun) await endRun(runId, signal.aborted ? "aborted" : "complete");
  return { results: memberResults, averages: byKey };
}

async function streamMember(
  member: { key: string; modelId: string; resolved: ResolvedModel; messageId: string },
  userContent: string,
  emit: Emit<CouncilEvent>,
  signal: AbortSignal,
): Promise<CouncilMemberResult> {
  const { descriptor, provider } = member.resolved;
  const messages: ChatMessage[] = [{ role: "user", content: userContent }];

  let acc = "";
  try {
    for await (const chunk of provider.stream({
      modelName: descriptor.modelName,
      messages,
      signal,
    })) {
      if (signal.aborted) break;
      acc += chunk.delta;
      const tokenEvt: CouncilMemberTokenEvent = {
        type: "member.token",
        memberKey: member.key,
        delta: chunk.delta,
      };
      emit(tokenEvt);
    }
  } catch (err) {
    await updateMessage(member.messageId, { content: acc, status: "error" });
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message: `${member.modelId}: ${message}` });
    return {
      memberKey: member.key,
      modelId: member.modelId,
      messageId: member.messageId,
      content: acc,
      status: "error",
    };
  }

  const status: "complete" | "aborted" = signal.aborted ? "aborted" : "complete";
  await updateMessage(member.messageId, { content: acc, status });
  const completeEvt: CouncilMemberCompleteEvent = {
    type: "member.complete",
    memberKey: member.key,
  };
  emit(completeEvt);

  return {
    memberKey: member.key,
    modelId: member.modelId,
    messageId: member.messageId,
    content: acc,
    status,
  };
}

async function scoreOne(
  params: CouncilParams,
  _userMessageId: string,
  scorer: { key: string; modelId: string; resolved: ResolvedModel; messageId: string },
  target: { key: string; modelId: string; messageId: string },
  targetResult: CouncilMemberResult,
  emit: Emit<CouncilEvent>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;

  const { descriptor, provider } = scorer.resolved;
  const messages: ChatMessage[] = [
    {
      role: "user",
      content:
        `Original question:\n${params.userContent}\n\n` +
        `Candidate response (from a different AI):\n${targetResult.content}\n\n` +
        `Score this response 0-100 and provide a brief reason.`,
    },
  ];

  let scoreValue: number | null = null;
  let rationale: string | null = null;
  try {
    const parsed = await provider.generateObject({
      modelName: descriptor.modelName,
      messages,
      system: SCORER_SYSTEM,
      schema: SCORE_SCHEMA,
      signal,
    });
    if (parsed) {
      scoreValue = parsed.score;
      rationale = parsed.brief_reason ?? null;
    }
  } catch {
    // Already handled by the provider's retry policy; leave score null.
  }

  // Persist a scorer message (links scorer_message_id in scores). Content
  // holds the rationale (or empty if the scorer failed).
  const scorerMsg = await insertMessage({
    conversationId: params.conversationId,
    role: "scorer",
    modelId: scorer.modelId,
    paneKey: `score:${scorer.key}->${target.key}`,
    content: rationale ?? "",
    status: scoreValue === null ? "error" : "complete",
  });

  await insertScore({
    conversationId: params.conversationId,
    scorerMessageId: scorerMsg.id,
    targetMessageId: target.messageId,
    scorerModelId: scorer.modelId,
    targetModelId: target.modelId,
    score: scoreValue,
    rationale,
  });

  emit({
    type: "score",
    scorerKey: scorer.key,
    targetKey: target.key,
    score: scoreValue,
  });
}
