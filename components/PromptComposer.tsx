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
      className="flex w-full items-end gap-2 border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
    >
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
        className="min-h-[2.5rem] flex-1 resize-none rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-magenta-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
      />
      {busy ? (
        <button
          type="button"
          onClick={() => onAbort?.()}
          className="rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className="rounded bg-magenta-600 px-3 py-2 text-sm font-medium text-white hover:bg-magenta-700 disabled:opacity-50"
        >
          Send
        </button>
      )}
    </form>
  );
}
