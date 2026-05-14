"use client";

import { useEffect, useRef, useState } from "react";
import { ModelSelect } from "./ModelSelect";
import { PromptComposer } from "./PromptComposer";
import { postSse } from "@/lib/sse/client";
import type { SingleEvent } from "@/lib/sse/events";
import type { Conversation, Message } from "@/lib/db/schema";

type Props = {
  conversation: Conversation;
};

type ApiResponse = {
  conversation: Conversation;
  messages: Message[];
};

export function SingleChatView({ conversation }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<string>("");
  const [modelId, setModelId] = useState<string | null>(
    (conversation.config as { modelId?: string }).modelId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/conversations/${conversation.id}`)
      .then((r) => r.json())
      .then((data: ApiResponse) => {
        if (!cancelled) setMessages(data.messages ?? []);
      })
      .catch(() => {
        /* leave empty; user will see an empty transcript */
      });
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  async function submit(text: string) {
    if (!modelId) return;
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
      clientMessageId: null,
      createdAt: new Date(),
    };
    setMessages((m) => [...m, userMsg]);
    setStreaming("");
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let acc = "";
      let finalId: string | null = null;
      for await (const event of postSse<SingleEvent>(
        "/api/chat/single",
        { conversationId: conversation.id, modelId, userContent: text },
        controller.signal,
      )) {
        if (event.type === "token") {
          acc += event.delta;
          setStreaming(acc);
        } else if (event.type === "message.complete") {
          finalId = event.messageId;
        } else if (event.type === "error") {
          acc = `${acc}\n\n[error] ${event.message}`;
          setStreaming(acc);
        }
      }

      const assistantMsg: Message = {
        id: finalId ?? crypto.randomUUID(),
        conversationId: conversation.id,
        parentId: null,
        role: "assistant",
        modelId,
        paneKey: null,
        round: null,
        content: acc,
        status: "complete",
        clientMessageId: null,
        createdAt: new Date(),
      };
      setMessages((m) => [...m, assistantMsg]);
      setStreaming("");
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages((m) => [
          ...m,
          {
            id: crypto.randomUUID(),
            conversationId: conversation.id,
            parentId: null,
            role: "assistant",
            modelId,
            paneKey: null,
            round: null,
            content: streaming + "\n\n[aborted]",
            status: "aborted",
            clientMessageId: null,
            createdAt: new Date(),
          },
        ]);
        setStreaming("");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((m) => [
          ...m,
          {
            id: crypto.randomUUID(),
            conversationId: conversation.id,
            parentId: null,
            role: "assistant",
            modelId,
            paneKey: null,
            round: null,
            content: `[error] ${message}`,
            status: "error",
            clientMessageId: null,
            createdAt: new Date(),
          },
        ]);
        setStreaming("");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-neutral-500 hover:text-magenta-600">
            ← Modes
          </a>
          <h1 className="font-semibold">Single chat</h1>
        </div>
        <ModelSelect value={modelId} onChange={setModelId} label="Model" />
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {streaming && (
            <MessageBubble
              message={{
                id: "streaming",
                conversationId: conversation.id,
                parentId: null,
                role: "assistant",
                modelId,
                paneKey: null,
                round: null,
                content: streaming,
                status: "streaming",
                clientMessageId: null,
                createdAt: new Date(),
              }}
            />
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <PromptComposer
        onSubmit={submit}
        onAbort={() => abortRef.current?.abort()}
        busy={busy}
        disabled={!modelId}
        placeholder={modelId ? "Type a message…" : "Pick a model first"}
      />
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm shadow-sm ${
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
