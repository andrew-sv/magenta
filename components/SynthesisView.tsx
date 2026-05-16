"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { ModelSelect } from "./ModelSelect";
import { PromptComposer } from "./PromptComposer";
import { postSse } from "@/lib/sse/client";
import type { SynthesisEvent } from "@/lib/sse/events";
import type { Conversation, Message, Score } from "@/lib/db/schema";

type Props = {
  conversation: Conversation;
};

type ApiResponse = {
  conversation: Conversation;
  messages: Message[];
  scores: Score[];
  averages: Record<string, number | null>;
};

type Member = {
  key: string;
  modelId: string | null;
  messageId: string | null;
  content: string;
  status: "idle" | "streaming" | "complete" | "error" | "aborted";
};

type ScoreBreakdown = {
  scorerKey: string;
  score: number | null;
};

const INITIAL_MEMBER_COUNT = 3;
const MAX_MEMBER_COUNT = 4;

export function SynthesisView({ conversation }: Props) {
  const cfg = (conversation.config as {
    memberModelIds?: string[];
    synthesizerId?: string;
  }) ?? {};

  const initialMembers: Member[] =
    cfg.memberModelIds && cfg.memberModelIds.length >= 2
      ? cfg.memberModelIds.map((id, i) => ({
          key: `member-${i}`,
          modelId: id,
          messageId: null,
          content: "",
          status: "idle",
        }))
      : Array.from({ length: INITIAL_MEMBER_COUNT }, (_, i) => ({
          key: `member-${i}`,
          modelId: null,
          messageId: null,
          content: "",
          status: "idle" as const,
        }));

  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [synthesizerModelId, setSynthesizerModelId] = useState<string | null>(
    cfg.synthesizerId ?? null,
  );
  const [userPrompt, setUserPrompt] = useState<string | null>(null);
  const [averages, setAverages] = useState<Record<string, number | null>>({});
  const [breakdowns, setBreakdowns] = useState<Record<string, ScoreBreakdown[]>>({});
  const [scoring, setScoring] = useState<"idle" | "running" | "complete">("idle");
  const [synth, setSynth] = useState<{
    modelId: string | null;
    content: string;
    status: "idle" | "streaming" | "complete" | "error" | "aborted";
  }>({ modelId: null, content: "", status: "idle" });
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/conversations/${conversation.id}`)
      .then((r) => r.json())
      .then((data: ApiResponse) => {
        if (cancelled) return;

        const userMsg = data.messages.find((m) => m.role === "user");
        if (userMsg) setUserPrompt(userMsg.content);

        const assistantMsgs = data.messages
          .filter((m) => m.role === "assistant" && m.paneKey)
          .sort((a, b) => a.paneKey!.localeCompare(b.paneKey!));

        const synthMsg = data.messages.find((m) => m.role === "synthesizer");

        if (assistantMsgs.length > 0) {
          setMembers(
            assistantMsgs.map((m) => ({
              key: m.paneKey!,
              modelId: m.modelId,
              messageId: m.id,
              content: m.content,
              status: (m.status ?? "complete") as Member["status"],
            })),
          );

          const messageIdToKey = new Map<string, string>();
          for (const m of assistantMsgs) messageIdToKey.set(m.id, m.paneKey!);

          const byKey: Record<string, number | null> = {};
          for (const [msgId, avg] of Object.entries(data.averages)) {
            const k = messageIdToKey.get(msgId);
            if (k) byKey[k] = avg;
          }
          setAverages(byKey);

          const bd: Record<string, ScoreBreakdown[]> = {};
          for (const s of data.scores) {
            const targetKey = messageIdToKey.get(s.targetMessageId);
            if (!targetKey) continue;
            const scorerKey =
              assistantMsgs.find((a) => a.modelId === s.scorerModelId)?.paneKey ??
              s.scorerModelId;
            (bd[targetKey] ??= []).push({ scorerKey, score: s.score });
          }
          setBreakdowns(bd);
          setScoring("complete");
        }

        if (synthMsg) {
          setSynth({
            modelId: synthMsg.modelId,
            content: synthMsg.content,
            status: (synthMsg.status ?? "complete") as typeof synth.status,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function setMember(key: string, patch: Partial<Member>) {
    setMembers((current) => current.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  }

  function addMember() {
    setMembers((current) => {
      if (current.length >= MAX_MEMBER_COUNT) return current;
      return [
        ...current,
        {
          key: `member-${current.length}`,
          modelId: null,
          messageId: null,
          content: "",
          status: "idle",
        },
      ];
    });
  }

  // Keep keys as a dense `member-0..N-1` sequence: the server reassigns them
  // the same way, so the SSE event keys would otherwise drift from ours.
  function removeMember(key: string) {
    setMembers((current) => {
      if (current.length <= 2) return current;
      return current
        .filter((m) => m.key !== key)
        .map((m, i) => ({ ...m, key: `member-${i}` }));
    });
  }

  const allPicked =
    members.every((m) => m.modelId !== null) && synthesizerModelId !== null;
  const uniqueIds = new Set(members.map((m) => m.modelId).filter(Boolean));
  const allDistinct = uniqueIds.size === members.length;
  const hasRun = members.some((m) => m.status !== "idle");
  const canSubmit = allPicked && allDistinct && !busy && !hasRun;

  async function submit(text: string) {
    if (!canSubmit) return;
    const modelIds = members.map((m) => m.modelId!).filter(Boolean) as string[];
    setUserPrompt(text);
    setAverages({});
    setBreakdowns({});
    setScoring("idle");
    setSynth({ modelId: synthesizerModelId, content: "", status: "idle" });
    setBusy(true);

    setMembers((current) =>
      current.map((m) => ({
        ...m,
        content: "",
        status: "streaming",
        messageId: null,
      })),
    );

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const event of postSse<SynthesisEvent>(
        "/api/chat/synthesis",
        {
          conversationId: conversation.id,
          memberModelIds: modelIds,
          synthesizerModelId,
          userContent: text,
        },
        controller.signal,
      )) {
        if (event.type === "member.start") {
          setMember(event.memberKey, {
            modelId: event.modelId,
            messageId: event.messageId,
            content: "",
            status: "streaming",
          });
        } else if (event.type === "member.token") {
          setMembers((current) =>
            current.map((m) =>
              m.key === event.memberKey ? { ...m, content: m.content + event.delta } : m,
            ),
          );
        } else if (event.type === "member.complete") {
          setMember(event.memberKey, { status: "complete" });
        } else if (event.type === "scoring.start") {
          setScoring("running");
        } else if (event.type === "score") {
          setBreakdowns((current) => {
            const list = current[event.targetKey] ?? [];
            return {
              ...current,
              [event.targetKey]: [
                ...list,
                { scorerKey: event.scorerKey, score: event.score },
              ],
            };
          });
        } else if (event.type === "scoring.complete") {
          setAverages(event.averages);
          setScoring("complete");
        } else if (event.type === "synthesis.start") {
          setSynth({ modelId: event.modelId, content: "", status: "streaming" });
        } else if (event.type === "synthesis.token") {
          setSynth((current) => ({ ...current, content: current.content + event.delta }));
        } else if (event.type === "synthesis.complete") {
          setSynth((current) => ({ ...current, status: "complete" }));
        } else if (event.type === "error") {
          setMembers((current) =>
            current.map((m) =>
              m.status === "streaming"
                ? { ...m, status: "error", content: m.content + `\n\n[error] ${event.message}` }
                : m,
            ),
          );
          setSynth((current) =>
            current.status === "streaming"
              ? { ...current, status: "error", content: current.content + `\n\n[error] ${event.message}` }
              : current,
          );
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        setMembers((current) =>
          current.map((m) =>
            m.status === "streaming"
              ? { ...m, status: "error", content: `[error] ${msg}` }
              : m,
          ),
        );
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-neutral-500 hover:text-magenta-600">
            ← Modes
          </a>
          <h1 className="font-semibold">Synthesis</h1>
          <span className="text-xs text-neutral-500">
            {members.length} members ·{" "}
            {synth.status === "complete"
              ? "synthesized"
              : synth.status === "streaming"
                ? "synthesizing…"
                : scoring === "complete"
                  ? "scored"
                  : scoring === "running"
                    ? "scoring…"
                    : hasRun
                      ? "answering…"
                      : "idle"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!allDistinct && (
            <span className="text-xs text-amber-600">Members must be distinct</span>
          )}
          {!hasRun && (
            <ModelSelect
              value={synthesizerModelId}
              onChange={setSynthesizerModelId}
              label="Synthesizer"
            />
          )}
          {members.length < MAX_MEMBER_COUNT && !hasRun && (
            <button
              onClick={addMember}
              className="rounded border border-neutral-300 px-2 py-1 text-xs hover:border-magenta-400 dark:border-neutral-700"
            >
              + Member
            </button>
          )}
        </div>
      </header>

      {userPrompt && (
        <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mx-auto max-w-5xl text-sm">
            <span className="text-neutral-500">Prompt: </span>
            <span className="whitespace-pre-wrap">{userPrompt}</span>
          </div>
        </div>
      )}

      <main className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <CouncilGrid
            members={members}
            averages={averages}
            breakdowns={breakdowns}
            scoringRunning={scoring === "running"}
            scoringComplete={scoring === "complete"}
            onChangeModel={(key, id) => setMember(key, { modelId: id })}
            onRemove={removeMember}
            canEdit={!hasRun}
            canRemove={members.length > 2}
          />
          {(synth.status !== "idle" || hasRun) && (
            <SynthPanel synth={synth} synthesizerId={synthesizerModelId} />
          )}
        </div>
      </main>

      <PromptComposer
        onSubmit={submit}
        onAbort={() => abortRef.current?.abort()}
        busy={busy}
        disabled={!canSubmit && !busy}
        placeholder={
          hasRun
            ? "Synthesis complete. Open a new conversation to ask again."
            : canSubmit
              ? "Ask the council, get one synthesized answer…"
              : !allDistinct
                ? "Members must be distinct"
                : !synthesizerModelId
                  ? "Pick a synthesizer model"
                  : "Pick a model for every seat"
        }
      />
    </div>
  );
}

function CouncilGrid({
  members,
  averages,
  breakdowns,
  scoringRunning,
  scoringComplete,
  onChangeModel,
  onRemove,
  canEdit,
  canRemove,
}: {
  members: Member[];
  averages: Record<string, number | null>;
  breakdowns: Record<string, ScoreBreakdown[]>;
  scoringRunning: boolean;
  scoringComplete: boolean;
  onChangeModel: (key: string, id: string) => void;
  onRemove: (key: string) => void;
  canEdit: boolean;
  canRemove: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {members.map((m) => (
        <MemberCard
          key={m.key}
          member={m}
          average={averages[m.key] ?? null}
          breakdown={breakdowns[m.key] ?? []}
          scoringRunning={scoringRunning}
          scoringComplete={scoringComplete}
          onChangeModel={(id) => onChangeModel(m.key, id)}
          onRemove={canRemove && canEdit ? () => onRemove(m.key) : undefined}
          canEdit={canEdit}
        />
      ))}
    </div>
  );
}

function MemberCard({
  member,
  average,
  breakdown,
  scoringRunning,
  scoringComplete,
  onChangeModel,
  onRemove,
  canEdit,
}: {
  member: Member;
  average: number | null;
  breakdown: ScoreBreakdown[];
  scoringRunning: boolean;
  scoringComplete: boolean;
  onChangeModel: (id: string) => void;
  onRemove?: () => void;
  canEdit: boolean;
}) {
  const showBadge = scoringComplete || (scoringRunning && breakdown.length > 0);
  const breakdownText = useMemo(() => {
    if (breakdown.length === 0) return null;
    return breakdown.map((b) => `${b.scorerKey}: ${b.score ?? "—"}`).join(" · ");
  }, [breakdown]);

  return (
    <section className="flex min-h-[12rem] flex-col rounded-lg border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          {canEdit ? (
            <ModelSelect value={member.modelId} onChange={onChangeModel} />
          ) : (
            <span className="text-sm font-medium">{member.modelId}</span>
          )}
          {member.status === "streaming" && (
            <span className="text-[11px] text-magenta-500">streaming…</span>
          )}
          {member.status === "error" && (
            <span className="text-[11px] text-red-500">error</span>
          )}
          {member.status === "aborted" && (
            <span className="text-[11px] text-red-500">aborted</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showBadge && <ScoreBadge average={average} title={breakdownText ?? undefined} />}
          {onRemove && (
            <button
              onClick={onRemove}
              className="text-xs text-neutral-500 hover:text-red-600"
            >
              remove
            </button>
          )}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-3 py-3 text-sm">
        {member.content ? (
          <Markdown>{member.content}</Markdown>
        ) : member.status === "streaming" ? (
          <span className="text-neutral-400">…</span>
        ) : (
          <span className="text-neutral-400">Waiting for prompt…</span>
        )}
      </div>
    </section>
  );
}

function SynthPanel({
  synth,
  synthesizerId,
}: {
  synth: { modelId: string | null; content: string; status: "idle" | "streaming" | "complete" | "error" | "aborted" };
  synthesizerId: string | null;
}) {
  const idle = synth.status === "idle";
  return (
    <section className="rounded-lg border-2 border-magenta-300 bg-magenta-50/50 shadow-sm dark:border-magenta-700 dark:bg-magenta-950/30">
      <header className="flex items-center justify-between gap-2 border-b border-magenta-200 px-4 py-2 text-sm dark:border-magenta-800">
        <div className="flex items-center gap-2">
          <span className="rounded bg-magenta-600 px-1.5 py-0.5 text-[11px] font-medium text-white">
            SYNTHESIS
          </span>
          <span className="text-neutral-700 dark:text-neutral-300">
            {synth.modelId ?? synthesizerId ?? "—"}
          </span>
        </div>
        {synth.status === "streaming" && (
          <span className="text-[11px] text-magenta-600">streaming…</span>
        )}
        {synth.status === "error" && (
          <span className="text-[11px] text-red-500">error</span>
        )}
      </header>
      <div className="px-4 py-3 text-sm">
        {synth.content ? (
          <Markdown>{synth.content}</Markdown>
        ) : (
          <span className="text-neutral-400">
            {idle ? "Waiting for council to finish…" : "…"}
          </span>
        )}
      </div>
    </section>
  );
}

function ScoreBadge({ average, title }: { average: number | null; title?: string }) {
  const label = average === null ? "—" : average.toFixed(0);
  const tone =
    average === null
      ? "bg-neutral-100 text-neutral-500 dark:bg-neutral-800"
      : average >= 80
        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-200"
        : average >= 60
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-200"
          : "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-200";
  return (
    <span
      title={title}
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  );
}
