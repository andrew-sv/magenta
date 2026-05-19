"use client";

import { useEffect, useRef, useState } from "react";
import { PromptComposer } from "./PromptComposer";
import { postSse } from "@/lib/sse/client";
import type { AnimateEvent } from "@/lib/sse/events";
import type {
  Conversation,
  Message,
  MessageAttachment,
} from "@/lib/db/schema";

type Props = {
  conversation: Conversation;
};

type ApiResponse = {
  conversation: Conversation;
  messages: Message[];
};

const ANIMATE_MODEL_ID = "comfyui:animatediff-sd15";

type Preset = { key: string; label: string; motionScale: number };

const PRESETS: Preset[] = [
  { key: "low", label: "Low motion (×0.6)", motionScale: 0.6 },
  { key: "high", label: "High motion (×1.2)", motionScale: 1.2 },
];

type RoundStatus =
  | { kind: "queued"; position: number | null }
  | { kind: "generating"; progress: { current: number; total: number } | null }
  | { kind: "complete"; gif: { path: string; mime: string } }
  | { kind: "aborted" }
  | { kind: "error"; message: string }
  | { kind: "interrupted" };

type Round = {
  id: string;
  prompt: string;
  status: RoundStatus;
};

type TileState = {
  key: string;
  label: string;
  motionScale: number;
  rounds: Round[];
  busy: boolean;
};

function initialTiles(): TileState[] {
  return PRESETS.map((p) => ({
    key: p.key,
    label: p.label,
    motionScale: p.motionScale,
    rounds: [],
    busy: false,
  }));
}

function gifAttachment(m: Message): MessageAttachment | null {
  for (const a of m.attachments ?? []) {
    if (a.kind === "image" && a.mime === "image/gif") return a;
  }
  // Fall back to any image-kind attachment (defensive — historical rows).
  for (const a of m.attachments ?? []) {
    if (a.kind === "image") return a;
  }
  return null;
}

function hydrateStatus(m: Message): RoundStatus {
  const attachment = gifAttachment(m);
  switch (m.status) {
    case "complete":
      if (attachment) {
        return { kind: "complete", gif: { path: attachment.path, mime: attachment.mime } };
      }
      return { kind: "error", message: "no GIF returned" };
    case "aborted":
      return { kind: "aborted" };
    case "error":
      return { kind: "error", message: m.content || "error" };
    case "streaming":
      return { kind: "interrupted" };
    default:
      return { kind: "interrupted" };
  }
}

export function AnimateView({ conversation }: Props) {
  const [tiles, setTiles] = useState<TileState[]>(() => initialTiles());
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/conversations/${conversation.id}`)
      .then((r) => r.json())
      .then((data: ApiResponse) => {
        if (cancelled) return;
        const sortedMessages = [...data.messages].sort((a, b) =>
          a.createdAt.toString().localeCompare(b.createdAt.toString()),
        );
        const userById = new Map<string, Message>();
        for (const m of sortedMessages) {
          if (m.role === "user") userById.set(m.id, m);
        }
        setTiles((current) =>
          current.map((tile) => {
            const assistants = sortedMessages.filter(
              (m) => m.role === "assistant" && m.paneKey === tile.key,
            );
            const rounds: Round[] = assistants.map((a) => {
              const userMsg = a.parentId ? userById.get(a.parentId) : undefined;
              return {
                id: a.id,
                prompt: userMsg?.content ?? a.content ?? "",
                status: hydrateStatus(a),
              };
            });
            return { ...tile, rounds };
          }),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  useEffect(() => {
    const controllers = abortControllers.current;
    return () => {
      for (const c of controllers.values()) c.abort();
      controllers.clear();
    };
  }, []);

  function patchTile(key: string, patch: Partial<TileState>) {
    setTiles((current) => current.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }

  function patchRound(tileKey: string, roundId: string, patch: Partial<Round>) {
    setTiles((current) =>
      current.map((t) =>
        t.key === tileKey
          ? {
              ...t,
              rounds: t.rounds.map((r) => (r.id === roundId ? { ...r, ...patch } : r)),
            }
          : t,
      ),
    );
  }

  const anyBusy = tiles.some((t) => t.busy);

  async function submit(text: string) {
    if (anyBusy) return;
    const clientMessageId = crypto.randomUUID();

    const placeholderId = (tileKey: string) => `pending-${tileKey}-${clientMessageId}`;
    setTiles((current) =>
      current.map((t) => ({
        ...t,
        busy: true,
        rounds: [
          ...t.rounds,
          {
            id: placeholderId(t.key),
            prompt: text,
            status: { kind: "queued", position: null },
          },
        ],
      })),
    );

    await Promise.all(
      tiles.map(async (tile) => {
        const controller = new AbortController();
        abortControllers.current.set(tile.key, controller);
        let roundId = placeholderId(tile.key);
        try {
          for await (const event of postSse<AnimateEvent>(
            "/api/chat/animate",
            {
              conversationId: conversation.id,
              modelId: ANIMATE_MODEL_ID,
              tileKey: tile.key,
              clientMessageId,
              prompt: text,
              motionScale: tile.motionScale,
            },
            controller.signal,
          )) {
            if (event.type === "animate.tile.meta") {
              const oldRoundId = roundId;
              const newRoundId = event.assistantMessageId;
              setTiles((current) =>
                current.map((t) =>
                  t.key === tile.key
                    ? {
                        ...t,
                        rounds: t.rounds.map((r) =>
                          r.id === oldRoundId ? { ...r, id: newRoundId } : r,
                        ),
                      }
                    : t,
                ),
              );
              roundId = newRoundId;
            } else if (event.type === "animate.queued") {
              patchRound(tile.key, roundId, {
                status: { kind: "queued", position: event.position },
              });
            } else if (event.type === "animate.progress") {
              patchRound(tile.key, roundId, {
                status: {
                  kind: "generating",
                  progress: { current: event.current, total: event.total },
                },
              });
            } else if (event.type === "animate.gif") {
              patchRound(tile.key, roundId, {
                status: {
                  kind: "complete",
                  gif: { path: event.path, mime: event.mime },
                },
              });
            } else if (event.type === "error") {
              patchRound(tile.key, roundId, {
                status: { kind: "error", message: event.message },
              });
            }
          }
        } catch (err) {
          if (controller.signal.aborted) {
            patchRound(tile.key, roundId, { status: { kind: "aborted" } });
          } else {
            patchRound(tile.key, roundId, {
              status: {
                kind: "error",
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
        } finally {
          patchTile(tile.key, { busy: false });
          abortControllers.current.delete(tile.key);
        }
      }),
    );
  }

  function stopAll() {
    for (const c of abortControllers.current.values()) c.abort();
    abortControllers.current.clear();
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-neutral-500 hover:text-magenta-600">
            ← Modes
          </a>
          <h1 className="font-semibold">Animate</h1>
          <a
            href="/animate/history"
            className="text-xs text-neutral-500 hover:text-magenta-600"
          >
            history →
          </a>
        </div>
        <span className="text-xs text-neutral-500">
          AnimateDiff SD1.5 · 16 frames · 8 fps
        </span>
      </header>

      <main className="flex flex-1 overflow-x-auto">
        {tiles.map((tile) => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </main>

      <PromptComposer
        onSubmit={submit}
        onAbort={stopAll}
        busy={anyBusy}
        disabled={anyBusy}
        placeholder="Describe a short animation…"
      />
    </div>
  );
}

function Tile({ tile }: { tile: TileState }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [tile.rounds]);

  return (
    <section className="flex min-w-[24rem] flex-1 flex-col border-r border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="text-sm font-medium">{tile.label}</span>
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
          ×{tile.motionScale.toFixed(2)}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-4">
          {tile.rounds.map((r) => (
            <RoundCard key={r.id} round={r} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: RoundStatus }) {
  const base =
    "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium";
  switch (status.kind) {
    case "queued":
      return (
        <span
          className={`${base} bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200`}
        >
          <Dot className="bg-neutral-500" pulse />
          queued{status.position !== null ? ` #${status.position}` : ""}
        </span>
      );
    case "generating": {
      const p = status.progress;
      const label = p ? `generating ${p.current}/${p.total}` : "generating…";
      return (
        <span
          className={`${base} bg-magenta-100 text-magenta-700 dark:bg-magenta-700/25 dark:text-magenta-100`}
        >
          <Dot className="bg-magenta-500" pulse />
          {label}
        </span>
      );
    }
    case "complete":
      return (
        <span
          className={`${base} bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200`}
        >
          <Dot className="bg-emerald-500" />
          complete
        </span>
      );
    case "aborted":
      return (
        <span
          className={`${base} bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300`}
        >
          <Dot className="bg-neutral-500" />
          aborted
        </span>
      );
    case "error":
      return (
        <span
          className={`${base} bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200`}
        >
          <Dot className="bg-red-500" />
          error
        </span>
      );
    case "interrupted":
      return (
        <span
          className={`${base} bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200`}
        >
          <Dot className="bg-amber-500" />
          interrupted
        </span>
      );
  }
}

function Dot({ className, pulse }: { className: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-1.5 w-1.5">
      {pulse && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${className}`}
        />
      )}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${className}`} />
    </span>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = Math.min(100, Math.round((current / Math.max(1, total)) * 100));
  return (
    <div
      className="h-1 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={current}
    >
      <div className="h-full bg-magenta-500 transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

function IndeterminateBar() {
  return (
    <div className="relative h-1 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
      <div className="absolute inset-y-0 left-0 w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded bg-magenta-500" />
      <style>{`
        @keyframes indeterminate {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(150%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </div>
  );
}

function RoundCard({ round }: { round: Round }) {
  const { status } = round;
  const showFinalGif = status.kind === "complete";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-neutral-500 dark:text-neutral-400">{round.prompt}</div>
        <StatusPill status={status} />
      </div>

      <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-950">
        {showFinalGif && status.kind === "complete" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={status.gif.path}
            alt={round.prompt}
            className="h-full w-full object-contain"
          />
        ) : status.kind === "error" ? (
          <span className="px-3 text-center text-xs text-red-600 dark:text-red-400">
            {status.message}
          </span>
        ) : status.kind === "aborted" ? (
          <span className="text-xs text-neutral-500">aborted</span>
        ) : status.kind === "interrupted" ? (
          <span className="px-3 text-center text-xs text-amber-700 dark:text-amber-300">
            interrupted — the server stopped streaming before a GIF was saved
          </span>
        ) : status.kind === "queued" ? (
          <span className="text-xs text-neutral-500">
            queued{status.position !== null ? ` #${status.position}` : "…"}
          </span>
        ) : (
          <span className="text-xs text-neutral-500">
            {status.progress
              ? `${status.progress.current} / ${status.progress.total}`
              : "starting…"}
          </span>
        )}
      </div>

      {status.kind === "generating" &&
        (status.progress ? (
          <ProgressBar current={status.progress.current} total={status.progress.total} />
        ) : (
          <IndeterminateBar />
        ))}

      {status.kind === "queued" && <IndeterminateBar />}
    </div>
  );
}
