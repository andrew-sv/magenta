"use client";

import { useEffect, useRef, useState } from "react";
import { postSse } from "@/lib/sse/client";
import type { MusicEvent } from "@/lib/sse/events";
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

type TileDef = {
  key: string;
  label: string;
  modelId: string;
  supportsLyrics: boolean;
};

const TILE_DEFS: TileDef[] = [
  {
    key: "song",
    label: "ACE-Step — song",
    modelId: "comfyui:ace-step-v1",
    supportsLyrics: true,
  },
  {
    key: "instrumental",
    label: "Stable Audio — instrumental",
    modelId: "comfyui:stable-audio-open",
    supportsLyrics: false,
  },
];

const DEFAULT_DURATION = 60;

type RoundStatus =
  | { kind: "queued"; position: number | null }
  | { kind: "generating"; progress: { current: number; total: number } | null }
  | { kind: "complete"; audio: { path: string; mime: string } }
  | { kind: "aborted" }
  | { kind: "error"; message: string }
  | { kind: "interrupted" };

type Round = {
  id: string;
  prompt: string;
  status: RoundStatus;
};

type TileState = TileDef & {
  rounds: Round[];
  busy: boolean;
};

function initialTiles(): TileState[] {
  return TILE_DEFS.map((t) => ({ ...t, rounds: [], busy: false }));
}

function audioAttachment(m: Message): MessageAttachment | null {
  for (const a of m.attachments ?? []) {
    if (a.kind === "audio") return a;
  }
  return null;
}

function hydrateStatus(m: Message): RoundStatus {
  const attachment = audioAttachment(m);
  switch (m.status) {
    case "complete":
      if (attachment) {
        return {
          kind: "complete",
          audio: { path: attachment.path, mime: attachment.mime },
        };
      }
      return { kind: "error", message: "no audio returned" };
    case "aborted":
      return { kind: "aborted" };
    case "error":
      return { kind: "error", message: m.content || "error" };
    default:
      return { kind: "interrupted" };
  }
}

export function MusicView({ conversation }: Props) {
  const [tiles, setTiles] = useState<TileState[]>(() => initialTiles());
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [duration, setDuration] = useState(DEFAULT_DURATION);
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
  const canSubmit = prompt.trim().length > 0 && !anyBusy;

  async function submit() {
    if (!canSubmit) return;
    const text = prompt.trim();
    const lyricsText = lyrics.trim();
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

    const snapshot = tiles;
    await Promise.all(
      snapshot.map(async (tile) => {
        const controller = new AbortController();
        abortControllers.current.set(tile.key, controller);
        let roundId = placeholderId(tile.key);
        try {
          for await (const event of postSse<MusicEvent>(
            "/api/chat/music",
            {
              conversationId: conversation.id,
              modelId: tile.modelId,
              tileKey: tile.key,
              clientMessageId,
              prompt: text,
              lyrics: tile.supportsLyrics && lyricsText ? lyricsText : undefined,
              durationSeconds: duration,
            },
            controller.signal,
          )) {
            if (event.type === "music.tile.meta") {
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
            } else if (event.type === "music.queued") {
              patchRound(tile.key, roundId, {
                status: { kind: "queued", position: event.position },
              });
            } else if (event.type === "music.progress") {
              patchRound(tile.key, roundId, {
                status: {
                  kind: "generating",
                  progress: { current: event.current, total: event.total },
                },
              });
            } else if (event.type === "music.audio") {
              patchRound(tile.key, roundId, {
                status: {
                  kind: "complete",
                  audio: { path: event.path, mime: event.mime },
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

    setPrompt("");
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
          <h1 className="font-semibold">Music</h1>
          <a
            href="/music/history"
            className="text-xs text-neutral-500 hover:text-magenta-600"
          >
            history →
          </a>
        </div>
        <span className="text-xs text-neutral-500">
          ACE-Step + Stable Audio · ComfyUI (serial queue)
        </span>
      </header>

      <main className="flex flex-1 overflow-x-auto">
        {tiles.map((tile) => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </main>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="border-t border-neutral-200 bg-white px-6 py-4 dark:border-neutral-800 dark:bg-neutral-950"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder="Style, genre, mood, instruments… (e.g. dreamy synthwave, female vocals, 120 BPM)"
            disabled={anyBusy}
            className="resize-none rounded-lg border border-neutral-300 bg-white px-4 py-3 text-sm leading-relaxed shadow-sm focus:border-magenta-400 focus:outline-none focus:ring-2 focus:ring-magenta-500/50 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <textarea
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            rows={2}
            placeholder="Lyrics (optional — used by ACE-Step; ignored by the instrumental tile). Use [verse] / [chorus] tags."
            disabled={anyBusy}
            className="resize-none rounded-lg border border-neutral-300 bg-white px-4 py-3 text-sm leading-relaxed shadow-sm focus:border-magenta-400 focus:outline-none focus:ring-2 focus:ring-magenta-500/50 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-neutral-500">
              Length
              <input
                type="number"
                min={5}
                max={240}
                step={1}
                value={duration}
                onChange={(e) =>
                  setDuration(
                    Math.max(5, Math.min(240, Number(e.target.value) || DEFAULT_DURATION)),
                  )
                }
                disabled={anyBusy}
                className="w-20 rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-magenta-400 focus:outline-none disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
              />
              sec
            </label>
            <span className="text-[11px] text-neutral-400">
              Stable Audio is trained for ≤47 s; longer requests degrade.
            </span>
            <div className="ml-auto">
              {anyBusy ? (
                <button
                  type="button"
                  onClick={stopAll}
                  className="rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-red-700"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="rounded-lg bg-magenta-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-magenta-700 disabled:opacity-50"
                >
                  Generate
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
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
          {tile.supportsLyrics ? "vocals" : "instrumental"}
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

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-neutral-500 dark:text-neutral-400">{round.prompt}</div>
        <StatusPill status={status} />
      </div>

      {status.kind === "complete" ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio controls preload="metadata" src={status.audio.path} className="w-full">
          <a href={status.audio.path}>Download audio</a>
        </audio>
      ) : (
        <div className="flex min-h-[3rem] w-full items-center justify-center rounded-md bg-neutral-100 px-3 py-4 text-center dark:bg-neutral-950">
          {status.kind === "error" ? (
            <span className="text-xs text-red-600 dark:text-red-400">{status.message}</span>
          ) : status.kind === "aborted" ? (
            <span className="text-xs text-neutral-500">aborted</span>
          ) : status.kind === "interrupted" ? (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              interrupted — the server stopped streaming before audio was saved
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
      )}

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
