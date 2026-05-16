import { resolveModel } from "@/lib/ai/resolve";
import type { ChatMessage } from "@/lib/ai/types";
import { getModelOrThrow } from "@/lib/ai/catalog";
import {
  endRun,
  insertMessage,
  startRun,
  updateMessage,
} from "@/lib/db/queries";
import type { SynthesisEvent } from "@/lib/sse/events";
import type { Emit } from "@/lib/sse/writer";
import { runCouncil } from "./council";

export type SynthesisParams = {
  conversationId: string;
  memberModelIds: string[];
  synthesizerModelId: string;
  userContent: string;
};

const SYNTHESIZER_SYSTEM =
  "You are a synthesizer. Several AI models have independently answered the same " +
  "question; each has been cross-rated by the others on a 0–100 scale for " +
  "correctness and usefulness. Produce ONE final answer to the original question. " +
  "Incorporate the strongest, best-rated material; resolve contradictions; correct " +
  "obvious errors. Do not summarize what each model said and do not include the " +
  "scores. Just answer the question directly and well.";

export async function runSynthesis(
  params: SynthesisParams,
  emit: Emit<SynthesisEvent>,
  signal: AbortSignal,
): Promise<void> {
  // One run per synthesis call, spanning both phases. runCouncil reuses this
  // run id instead of opening its own, so we get a single row that tracks the
  // user-facing operation.
  const run = await startRun({
    conversationId: params.conversationId,
    mode: "synthesis",
  });

  let results: Awaited<ReturnType<typeof runCouncil>>["results"];
  let averages: Awaited<ReturnType<typeof runCouncil>>["averages"];
  try {
    // SynthesisEvent extends CouncilEvent, so the emit cast below is safe.
    ({ results, averages } = await runCouncil(
      {
        conversationId: params.conversationId,
        memberModelIds: params.memberModelIds,
        userContent: params.userContent,
        existingRunId: run.id,
      },
      emit as unknown as Emit<import("@/lib/sse/events").CouncilEvent>,
      signal,
    ));
  } catch (err) {
    await endRun(run.id, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }

  if (signal.aborted) {
    await endRun(run.id, "aborted");
    return;
  }

  // Phase 2 — run the synthesizer over the council results.
  const { descriptor, provider } = resolveModel(params.synthesizerModelId);

  const synthMessage = await insertMessage({
    conversationId: params.conversationId,
    role: "synthesizer",
    modelId: params.synthesizerModelId,
    content: "",
    status: "streaming",
  });

  emit({
    type: "synthesis.start",
    modelId: params.synthesizerModelId,
    messageId: synthMessage.id,
  });

  // Build the synthesizer input. Drop members that didn't complete cleanly.
  const completed = results.filter((r) => r.status === "complete" && r.content.trim());
  const transcript = completed
    .map((r, i) => {
      const label = getModelOrThrow(r.modelId).label;
      const avg = averages[r.memberKey];
      const avgStr = avg === null || avg === undefined ? "n/a" : avg.toFixed(0);
      return `### Candidate ${i + 1}: ${label}  (avg score: ${avgStr})\n${r.content.trim()}`;
    })
    .join("\n\n");

  const userPrompt =
    `Original question:\n${params.userContent}\n\n` +
    `Candidate responses from ${completed.length} AI model${completed.length === 1 ? "" : "s"}:\n\n` +
    `${transcript}\n\n` +
    `Produce one final answer to the original question. Make it directly useful, ` +
    `well-structured, and better than any individual candidate.`;

  const messages: ChatMessage[] = [{ role: "user", content: userPrompt }];

  let acc = "";
  try {
    for await (const chunk of provider.stream({
      modelName: descriptor.modelName,
      messages,
      system: SYNTHESIZER_SYSTEM,
      signal,
    })) {
      if (signal.aborted) break;
      acc += chunk.delta;
      emit({ type: "synthesis.token", delta: chunk.delta });
    }
  } catch (err) {
    await updateMessage(synthMessage.id, { content: acc, status: "error" });
    await endRun(run.id, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }

  if (signal.aborted) {
    await updateMessage(synthMessage.id, { content: acc, status: "aborted" });
    await endRun(run.id, "aborted");
    return;
  }

  await updateMessage(synthMessage.id, { content: acc, status: "complete" });
  await endRun(run.id, "complete");
  emit({ type: "synthesis.complete" });
}
