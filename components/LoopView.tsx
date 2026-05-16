"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { ModelSelect } from "./ModelSelect";
import { PromptComposer } from "./PromptComposer";
import { postSse } from "@/lib/sse/client";
import type { LoopEvent } from "@/lib/sse/events";
import type { Conversation, Message } from "@/lib/db/schema";

type Props = {
  conversation: Conversation;
};

type ApiResponse = {
  conversation: Conversation;
  messages: Message[];
};

type Turn = {
  id: string;
  role: "A" | "B" | "user";
  round: number;
  modelId: string | null;
  content: string;
  status: "streaming" | "complete" | "aborted" | "error";
};

export function LoopView({ conversation }: Props) {
  const cfg = (conversation.config as {
    modelA?: string;
    modelB?: string;
    maxRounds?: number;
  }) ?? {};

  const [modelA, setModelA] = useState<string | null>(cfg.modelA ?? null);
  const [modelB, setModelB] = useState<string | null>(cfg.modelB ?? null);
  const [maxRounds, setMaxRounds] = useState<number>(cfg.maxRounds ?? 3);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [completedRounds, setCompletedRounds] = useState(0);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/conversations/${conversation.id}`)
      .then((r) => r.json())
      .then((data: ApiResponse) => {
        if (cancelled) return;
        setTurns(
          data.messages.map((m) => ({
            id: m.id,
            role:
              m.role === "user"
                ? "user"
                : (m.paneKey as "A" | "B" | null) ?? "A",
            round: m.round ?? 0,
            modelId: m.modelId,
            content: m.content,
            status: (m.status ?? "complete") as Turn["status"],
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function submit(text: string) {
    if (!modelA || !modelB) return;
    const userTurn: Turn = {
      id: crypto.randomUUID(),
      role: "user",
      round: 0,
      modelId: null,
      content: text,
      status: "complete",
    };
    setTurns([userTurn]);
    setCompletedRounds(0);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const event of postSse<LoopEvent>(
        "/api/chat/loop",
        {
          conversationId: conversation.id,
          modelAId: modelA,
          modelBId: modelB,
          userContent: text,
          maxRounds,
        },
        controller.signal,
      )) {
        if (event.type === "turn.start") {
          const newTurn: Turn = {
            id: event.turnId,
            role: event.role,
            round: event.round,
            modelId: event.modelId,
            content: "",
            status: "streaming",
          };
          setTurns((current) => [...current, newTurn]);
        } else if (event.type === "token") {
          setTurns((current) =>
            current.map((t) =>
              t.id === event.turnId ? { ...t, content: t.content + event.delta } : t,
            ),
          );
        } else if (event.type === "turn.complete") {
          setTurns((current) =>
            current.map((t) => (t.id === event.turnId ? { ...t, status: "complete" } : t)),
          );
        } else if (event.type === "loop.complete") {
          setCompletedRounds(event.rounds);
        } else if (event.type === "aborted") {
          setTurns((current) =>
            current.map((t) => (t.status === "streaming" ? { ...t, status: "aborted" } : t)),
          );
        } else if (event.type === "error") {
          setTurns((current) =>
            current.map((t) =>
              t.status === "streaming"
                ? { ...t, status: "error", content: t.content + `\n\n[error] ${event.message}` }
                : t,
            ),
          );
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        setTurns((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "A",
            round: 0,
            modelId: null,
            content: `[error] ${msg}`,
            status: "error",
          },
        ]);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const canSubmit = modelA !== null && modelB !== null && !busy && turns.length === 0;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-neutral-500 hover:text-magenta-600">
            ← Modes
          </a>
          <h1 className="font-semibold">Loop (A ↔ B)</h1>
          <span className="text-xs text-neutral-500">
            Round {completedRounds} / {maxRounds}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ModelSelect value={modelA} onChange={setModelA} label="A (answers)" />
          <ModelSelect value={modelB} onChange={setModelB} label="B (asks)" />
          <label className="inline-flex items-center gap-2 text-sm">
            <span className="text-neutral-600 dark:text-neutral-400">Rounds</span>
            <input
              type="number"
              min={1}
              max={20}
              value={maxRounds}
              onChange={(e) => setMaxRounds(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
              className="w-16 rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              disabled={busy || turns.length > 0}
            />
          </label>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {turns.map((t) => (
            <TurnBubble key={t.id} turn={t} />
          ))}
          <div ref={bottomRef} />
        </div>
      </main>

      <PromptComposer
        onSubmit={submit}
        onAbort={() => abortRef.current?.abort()}
        busy={busy}
        disabled={!canSubmit && !busy}
        placeholder={
          turns.length > 0
            ? "Loop is in progress or finished. Open a new conversation to start over."
            : canSubmit
              ? "Seed prompt for Model A…"
              : "Pick A and B first"
        }
      />
    </div>
  );
}

function TurnBubble({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-magenta-600 px-4 py-2 text-sm text-white shadow-sm">
          {turn.content}
        </div>
      </div>
    );
  }

  const isA = turn.role === "A";
  const align = isA ? "justify-start" : "justify-end";
  const badge = isA ? "A · answer" : "B · question";
  const badgeStyle = isA
    ? "bg-magenta-100 text-magenta-700 dark:bg-magenta-700/30 dark:text-magenta-200"
    : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";

  return (
    <div className={`flex ${align}`}>
      <div className="flex max-w-[85%] flex-col gap-1">
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <span className={`rounded px-1.5 py-0.5 ${badgeStyle}`}>{badge}</span>
          <span>round {turn.round}</span>
          {turn.status === "streaming" && <span className="text-magenta-500">streaming…</span>}
          {turn.status === "aborted" && <span className="text-red-500">aborted</span>}
          {turn.status === "error" && <span className="text-red-500">error</span>}
        </div>
        <div className="rounded-2xl bg-white px-4 py-2 text-sm shadow-sm dark:bg-neutral-900">
          {turn.content ? (
            <Markdown>{turn.content}</Markdown>
          ) : turn.status === "streaming" ? (
            <span className="text-neutral-400">…</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
