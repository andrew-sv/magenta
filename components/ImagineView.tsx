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

type Round = {
  id: string;
  prompt: string;
  status: "queued" | "generating" | "complete" | "aborted" | "error";
  queuedPosition: number | null;
  progress: { current: number; total: number } | null;
  preview: { mime: string; dataBase64: string } | null;
  image: { path: string; mime: string } | null;
  error: string | null;
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
              const attachment = imageAttachment(a);
              const userMsg = a.parentId ? userById.get(a.parentId) : undefined;
              return {
                id: a.id,
                prompt: userMsg?.content ?? a.content ?? "",
                status:
                  a.status === "complete"
                    ? "complete"
                    : a.status === "aborted"
                      ? "aborted"
                      : a.status === "error"
                        ? "error"
                        : "generating",
                queuedPosition: null,
                progress: null,
                preview: null,
                image: attachment
                  ? { path: attachment.path, mime: attachment.mime }
                  : null,
                error: null,
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

    // Pre-create a "queued" round in each tile so the UI is responsive.
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
            status: "queued",
            queuedPosition: null,
            progress: null,
            preview: null,
            image: null,
            error: null,
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
              // Promote the placeholder round to use the real assistant message id.
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
                status: "generating",
                queuedPosition: event.position,
              });
            } else if (event.type === "imagine.progress") {
              patchRound(tile.key, roundId, {
                status: "generating",
                progress: { current: event.current, total: event.total },
              });
            } else if (event.type === "imagine.preview") {
              patchRound(tile.key, roundId, {
                preview: { mime: event.mime, dataBase64: event.dataBase64 },
              });
            } else if (event.type === "imagine.image") {
              patchRound(tile.key, roundId, {
                status: "complete",
                progress: null,
                preview: null,
                image: { path: event.path, mime: event.mime },
              });
            } else if (event.type === "error") {
              patchRound(tile.key, roundId, {
                status: "error",
                error: event.message,
              });
            }
          }
        } catch (err) {
          if (controller.signal.aborted) {
            patchRound(tile.key, roundId, { status: "aborted" });
          } else {
            patchRound(tile.key, roundId, {
              status: "error",
              error: err instanceof Error ? err.message : String(err),
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

function RoundCard({ round }: { round: Round }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{round.prompt}</div>

      <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-950">
        {round.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={round.image.path}
            alt={round.prompt}
            className="h-full w-full object-contain"
          />
        ) : round.preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:${round.preview.mime};base64,${round.preview.dataBase64}`}
            alt={`preview: ${round.prompt}`}
            className="h-full w-full object-contain opacity-90"
          />
        ) : round.status === "error" ? (
          <span className="px-3 text-center text-xs text-red-600">{round.error ?? "error"}</span>
        ) : round.status === "aborted" ? (
          <span className="text-xs text-neutral-500">aborted</span>
        ) : (
          <span className="text-xs text-neutral-500">
            {round.status === "queued" ? "queued…" : "generating…"}
          </span>
        )}
      </div>

      {round.status === "generating" && round.progress && (
        <div className="h-1 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
          <div
            className="h-full bg-magenta-500 transition-all"
            style={{
              width: `${Math.min(100, Math.round((round.progress.current / Math.max(1, round.progress.total)) * 100))}%`,
            }}
          />
        </div>
      )}

      {round.queuedPosition !== null && round.status === "generating" && !round.progress && (
        <div className="text-xs text-neutral-500">queue position #{round.queuedPosition}</div>
      )}
    </div>
  );
}
