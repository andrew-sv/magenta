"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ConversationMode =
  | "single"
  | "fanout"
  | "loop"
  | "council"
  | "synthesis"
  | "imagine"
  | "animate";

type Mode = {
  id: ConversationMode;
  title: string;
  description: string;
  ready: boolean;
};

const MODES: Mode[] = [
  {
    id: "single",
    title: "Single",
    description: "One model. Standard chat.",
    ready: true,
  },
  {
    id: "fanout",
    title: "Fanout",
    description: "Two or more models, one prompt, side-by-side panes.",
    ready: true,
  },
  {
    id: "loop",
    title: "Loop (A ↔ B)",
    description: "Model A answers, Model B asks follow-ups. Stops after N rounds.",
    ready: true,
  },
  {
    id: "council",
    title: "Council",
    description: "3–4 models answer. Each scores the others 0–100.",
    ready: true,
  },
  {
    id: "synthesis",
    title: "Synthesis",
    description: "Council, then a synthesizer model combines everything into one answer.",
    ready: true,
  },
  {
    id: "imagine",
    title: "Imagine",
    description: "Two or more image models, same prompt, side-by-side tiles. Powered by ComfyUI.",
    ready: true,
  },
  {
    id: "animate",
    title: "Animate",
    description: "AnimateDiff GIFs, same prompt at low and high motion. Powered by ComfyUI.",
    ready: true,
  },
];

export function ModePicker() {
  const router = useRouter();
  const [pending, setPending] = useState<ConversationMode | null>(null);

  async function startConversation(mode: ConversationMode) {
    setPending(mode);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error(`Failed to create conversation: ${res.status}`);
      const data = (await res.json()) as { conversation: { id: string } };
      router.push(`/chat/${data.conversation.id}`);
    } catch (err) {
      console.error(err);
      setPending(null);
    }
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-8 md:grid-cols-2 lg:grid-cols-3">
      {MODES.map((m) => (
        <button
          key={m.id}
          onClick={() => m.ready && startConversation(m.id)}
          disabled={!m.ready || pending !== null}
          className="flex flex-col items-start gap-2 rounded-lg border border-neutral-200 bg-white p-5 text-left shadow-sm transition hover:border-magenta-400 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="flex w-full items-center justify-between">
            <h3 className="font-semibold">{m.title}</h3>
            {!m.ready && (
              <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                soon
              </span>
            )}
            {pending === m.id && (
              <span className="text-xs text-magenta-600">starting…</span>
            )}
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{m.description}</p>
        </button>
      ))}
    </div>
  );
}
