"use client";

import { useState, type FormEvent } from "react";

type Props = {
  onSubmit: (text: string) => void;
  onAbort?: () => void;
  busy?: boolean;
  placeholder?: string;
  disabled?: boolean;
};

export function PromptComposer({ onSubmit, onAbort, busy, placeholder, disabled }: Props) {
  const [text, setText] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    onSubmit(trimmed);
    setText("");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-neutral-200 bg-white px-6 py-4 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="mx-auto flex w-full max-w-3xl items-end gap-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e as unknown as FormEvent);
            }
          }}
          rows={2}
          placeholder={placeholder ?? "Type a message…"}
          disabled={disabled}
          className="min-h-[3rem] flex-1 resize-none rounded-lg border border-neutral-300 bg-white px-4 py-3 text-sm leading-relaxed shadow-sm focus:border-magenta-400 focus:outline-none focus:ring-2 focus:ring-magenta-500/50 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => onAbort?.()}
            className="rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-red-700"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !text.trim()}
            className="rounded-lg bg-magenta-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-magenta-700 disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}
