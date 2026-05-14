"use client";

import { useEffect, useRef, useState } from "react";
import { ModelSelect } from "./ModelSelect";
import { PromptComposer } from "./PromptComposer";
import { postSse } from "@/lib/sse/client";
import type { FanoutEvent } from "@/lib/sse/events";
import type { Conversation, Message } from "@/lib/db/schema";

type Props = {
  conversation: Conversation;
};

type ApiResponse = {
  conversation: Conversation;
  messages: Message[];
};

type PaneState = {
  key: string;
  modelId: string | null;
  messages: Message[];
  streaming: string;
  busy: boolean;
};

export function FanoutView({ conversation }: Props) {
  const initialPanes = ((conversation.config as { paneModelIds?: string[] }).paneModelIds ?? [])
    .map((id, idx) => ({
      key: `pane-${idx}`,
      modelId: id,
      messages: [] as Message[],
      streaming: "",
      busy: false,
    }));
  const [panes, setPanes] = useState<PaneState[]>(
    initialPanes.length >= 2
      ? initialPanes
      : [
          { key: "pane-0", modelId: null, messages: [], streaming: "", busy: false },
          { key: "pane-1", modelId: null, messages: [], streaming: "", busy: false },
        ],
  );
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/conversations/${conversation.id}`)
      .then((r) => r.json())
      .then((data: ApiResponse) => {
        if (cancelled) return;
        // Group messages: assistant messages with a paneKey go to that pane;
        // user messages are shared (we attach them to every pane for display).
        const userMessages = data.messages.filter((m) => m.role === "user");
        setPanes((current) =>
          current.map((p) => ({
            ...p,
            messages: [
              ...userMessages,
              ...data.messages.filter((m) => m.role === "assistant" && m.paneKey === p.key),
            ].sort((a, b) => a.createdAt.toString().localeCompare(b.createdAt.toString())),
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  function setPane(key: string, patch: Partial<PaneState>) {
    setPanes((current) => current.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  function addPane() {
    setPanes((current) => [
      ...current,
      {
        key: `pane-${current.length}`,
        modelId: null,
        messages: [],
        streaming: "",
        busy: false,
      },
    ]);
  }

  function removePane(key: string) {
    abortControllers.current.get(key)?.abort();
    abortControllers.current.delete(key);
    setPanes((current) => current.filter((p) => p.key !== key));
  }

  const anyBusy = panes.some((p) => p.busy);
  const canSubmit = panes.every((p) => p.modelId !== null) && !anyBusy;

  async function submit(text: string) {
    if (!canSubmit) return;
    const clientMessageId = crypto.randomUUID();
    const userMsg: Message = {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      modelId: null,
      paneKey: null,
      round: null,
      content: text,
      status: "complete",
      clientMessageId,
      createdAt: new Date(),
    };

    setPanes((current) =>
      current.map((p) => ({
        ...p,
        messages: [...p.messages, userMsg],
        streaming: "",
        busy: true,
      })),
    );

    await Promise.all(
      panes.map(async (pane) => {
        if (!pane.modelId) return;
        const controller = new AbortController();
        abortControllers.current.set(pane.key, controller);
        try {
          let acc = "";
          for await (const event of postSse<FanoutEvent>(
            "/api/chat/fanout",
            {
              conversationId: conversation.id,
              modelId: pane.modelId,
              paneKey: pane.key,
              clientMessageId,
              userContent: text,
            },
            controller.signal,
          )) {
            if (event.type === "token") {
              acc += event.delta;
              setPane(pane.key, { streaming: acc });
            } else if (event.type === "message.complete") {
              const assistantMsg: Message = {
                id: event.messageId,
                conversationId: conversation.id,
                parentId: null,
                role: "assistant",
                modelId: pane.modelId,
                paneKey: pane.key,
                round: null,
                content: acc,
                status: "complete",
                clientMessageId: null,
                createdAt: new Date(),
              };
              setPanes((current) =>
                current.map((p) =>
                  p.key === pane.key
                    ? {
                        ...p,
                        messages: [...p.messages, assistantMsg],
                        streaming: "",
                      }
                    : p,
                ),
              );
            } else if (event.type === "error") {
              acc += `\n\n[error] ${event.message}`;
              setPane(pane.key, { streaming: acc });
            }
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            const msg = err instanceof Error ? err.message : String(err);
            setPane(pane.key, { streaming: `[error] ${msg}` });
          }
        } finally {
          setPane(pane.key, { busy: false });
          abortControllers.current.delete(pane.key);
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
          <h1 className="font-semibold">Fanout</h1>
        </div>
        <button
          onClick={addPane}
          className="rounded border border-neutral-300 px-2 py-1 text-sm hover:border-magenta-400 dark:border-neutral-700"
        >
          + Add pane
        </button>
      </header>

      <main className="flex flex-1 overflow-x-auto">
        {panes.map((pane) => (
          <Pane
            key={pane.key}
            pane={pane}
            onModelChange={(id) => setPane(pane.key, { modelId: id })}
            onRemove={() => removePane(pane.key)}
            canRemove={panes.length > 2}
          />
        ))}
      </main>

      <PromptComposer
        onSubmit={submit}
        onAbort={stopAll}
        busy={anyBusy}
        disabled={!canSubmit && !anyBusy}
        placeholder={canSubmit ? "Type a message…" : "Pick a model for every pane"}
      />
    </div>
  );
}

function Pane({
  pane,
  onModelChange,
  onRemove,
  canRemove,
}: {
  pane: PaneState;
  onModelChange: (id: string) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [pane.messages, pane.streaming]);

  return (
    <section className="flex min-w-[20rem] flex-1 flex-col border-r border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <ModelSelect value={pane.modelId} onChange={onModelChange} />
        {canRemove && (
          <button
            onClick={onRemove}
            className="text-xs text-neutral-500 hover:text-red-600"
          >
            remove
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-3">
          {pane.messages.map((m) => (
            <Bubble key={m.id} message={m} />
          ))}
          {pane.streaming && (
            <Bubble
              message={{
                id: "streaming",
                conversationId: "",
                parentId: null,
                role: "assistant",
                modelId: pane.modelId,
                paneKey: pane.key,
                round: null,
                content: pane.streaming,
                status: "streaming",
                clientMessageId: null,
                createdAt: new Date(),
              }}
            />
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </section>
  );
}

function Bubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm ${
          isUser
            ? "bg-magenta-600 text-white"
            : "bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
        }`}
      >
        {message.content || (message.status === "streaming" ? "…" : "")}
      </div>
    </div>
  );
}
