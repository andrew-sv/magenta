"use client";

import { useEffect, useRef, useState } from "react";
import { ModelSelect } from "./ModelSelect";
import { PromptComposer } from "./PromptComposer";
import { postSse } from "@/lib/sse/client";
import type { ImagineEvent } from "@/lib/sse/events";
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

type RoundStatus =
  | { kind: "queued"; position: number | null }
  | { kind: "generating"; progress: { current: number; total: number } | null }
  | { kind: "complete"; image: { path: string; mime: string } }
  | { kind: "aborted" }
  | { kind: "error"; message: string }
  // Hydrated from a DB row that was still `streaming` — its SSE stream is
  // gone (page reload, server restart), so it's effectively orphaned.
  | { kind: "interrupted" };

type Round = {
  id: string;
  prompt: string;
  preview: { mime: string; dataBase64: string } | null;
  status: RoundStatus;
};

type TileState = {
  key: string;
  modelId: string | null;
  rounds: Round[];
  busy: boolean;
};

const DEFAULT_INITIAL_TILES = (): TileState[] => [
  { key: "tile-0", modelId: null, rounds: [], busy: false },
  { key: "tile-1", modelId: null, rounds: [], busy: false },
];

function imageAttachment(m: Message): MessageAttachment | null {
  for (const a of m.attachments ?? []) {
    if (a.kind === "image") return a;
  }
  return null;
}

function hydrateStatus(m: Message): RoundStatus {
  const attachment = imageAttachment(m);
  switch (m.status) {
    case "complete":
      if (attachment) {
        return { kind: "complete", image: { path: attachment.path, mime: attachment.mime } };
      }
      // Legacy rows: marked complete in the DB but no image was actually
      // saved (e.g. ComfyUI global interrupt). Surface as an error so the
      // UI doesn't mislead.
      return { kind: "error", message: "no image returned" };
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

export function ImagineView({ conversation }: Props) {
  const initialTiles = (
    (conversation.config as { tileModelIds?: string[] }).tileModelIds ?? []
  ).map((id, idx) => ({
    key: `tile-${idx}`,
    modelId: id,
    rounds: [] as Round[],
    busy: false,
  }));
  const [tiles, setTiles] = useState<TileState[]>(
    initialTiles.length >= 2 ? initialTiles : DEFAULT_INITIAL_TILES(),
  );
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  // Hydrate prior rounds from DB.
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
                preview: null,
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

  // Cancel in-flight on unmount.
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

  function addTile() {
    setTiles((current) => [
      ...current,
      { key: `tile-${current.length}`, modelId: null, rounds: [], busy: false },
    ]);
  }

  function removeTile(key: string) {
    abortControllers.current.get(key)?.abort();
    abortControllers.current.delete(key);
    setTiles((current) => current.filter((t) => t.key !== key));
  }

  const anyBusy = tiles.some((t) => t.busy);
  const canSubmit = tiles.every((t) => t.modelId !== null) && !anyBusy;

  async function submit(text: string) {
    if (!canSubmit) return;
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
            preview: null,
            status: { kind: "queued", position: null },
          },
        ],
      })),
    );

    await Promise.all(
      tiles.map(async (tile) => {
        if (!tile.modelId) return;
        const controller = new AbortController();
        abortControllers.current.set(tile.key, controller);
        let roundId = placeholderId(tile.key);
        try {
          for await (const event of postSse<ImagineEvent>(
            "/api/chat/imagine",
            {
              conversationId: conversation.id,
              modelId: tile.modelId,
              tileKey: tile.key,
              clientMessageId,
              prompt: text,
            },
            controller.signal,
          )) {
            if (event.type === "tile.meta") {
              // Snapshot the ids in const-locals first: the setTiles updater runs
              // lazily, and if we let it close over the outer `let roundId`, a
              // reassignment below would change what id it tries to match.
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
            } else if (event.type === "imagine.queued") {
              patchRound(tile.key, roundId, {
                status: { kind: "queued", position: event.position },
              });
            } else if (event.type === "imagine.progress") {
              patchRound(tile.key, roundId, {
                status: {
                  kind: "generating",
                  progress: { current: event.current, total: event.total },
                },
              });
            } else if (event.type === "imagine.preview") {
              patchRound(tile.key, roundId, {
                preview: { mime: event.mime, dataBase64: event.dataBase64 },
              });
            } else if (event.type === "imagine.image") {
              patchRound(tile.key, roundId, {
                preview: null,
                status: {
                  kind: "complete",
                  image: { path: event.path, mime: event.mime },
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
          <h1 className="font-semibold">Imagine</h1>
          <a
            href="/imagine/history"
            className="text-xs text-neutral-500 hover:text-magenta-600"
          >
            history →
          </a>
        </div>
        <button
          onClick={addTile}
          disabled={anyBusy}
          className="rounded border border-neutral-300 px-2 py-1 text-sm hover:border-magenta-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700"
        >
          + Add tile
        </button>
      </header>

      <main className="flex flex-1 overflow-x-auto">
        {tiles.map((tile) => (
          <Tile
            key={tile.key}
            tile={tile}
            onModelChange={(id) => patchTile(tile.key, { modelId: id })}
            onRemove={() => removeTile(tile.key)}
            canRemove={tiles.length > 2 && !anyBusy}
          />
        ))}
      </main>

      <PromptComposer
        onSubmit={submit}
        onAbort={stopAll}
        busy={anyBusy}
        disabled={!canSubmit && !anyBusy}
        placeholder={canSubmit ? "Describe an image…" : "Pick a model for every tile"}
      />
    </div>
  );
}

function Tile({
  tile,
  onModelChange,
  onRemove,
  canRemove,
}: {
  tile: TileState;
  onModelChange: (id: string) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [tile.rounds]);

  return (
    <section className="flex min-w-[24rem] flex-1 flex-col border-r border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <ModelSelect value={tile.modelId} onChange={onModelChange} filterKind="image" />
        {canRemove && (
          <button onClick={onRemove} className="text-xs text-neutral-500 hover:text-red-600">
            remove
          </button>
        )}
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
      const label = p
        ? `generating ${p.current}/${p.total}`
        : "generating…";
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
  // What goes inside the image frame depends on whether we have a final image,
  // a streaming preview, or just an empty state.
  const showFinalImage = status.kind === "complete";
  const showPreview = !showFinalImage && round.preview !== null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-neutral-500 dark:text-neutral-400">{round.prompt}</div>
        <StatusPill status={status} />
      </div>

      <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-950">
        {showFinalImage && status.kind === "complete" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={status.image.path}
            alt={round.prompt}
            className="h-full w-full object-contain"
          />
        ) : showPreview && round.preview ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:${round.preview.mime};base64,${round.preview.dataBase64}`}
              alt={`preview: ${round.prompt}`}
              className="h-full w-full object-contain opacity-90"
            />
            <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-white">
              preview
            </span>
          </>
        ) : status.kind === "error" ? (
          <span className="px-3 text-center text-xs text-red-600 dark:text-red-400">
            {status.message}
          </span>
        ) : status.kind === "aborted" ? (
          <span className="text-xs text-neutral-500">aborted</span>
        ) : status.kind === "interrupted" ? (
          <span className="px-3 text-center text-xs text-amber-700 dark:text-amber-300">
            interrupted — the server stopped streaming before an image was saved
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
