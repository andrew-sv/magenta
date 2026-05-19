"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  conversationId: string;
  /**
   * Used in the confirm prompt so the user knows what they're about to delete.
   * Falls back to the id when omitted.
   */
  label?: string;
  /**
   * When true (imagine conversations), the confirm wording mentions that
   * generated image files will also be removed.
   */
  withFiles?: boolean;
  className?: string;
};

export function DeleteConversationButton({
  conversationId,
  label,
  withFiles,
  className,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick(e: React.MouseEvent<HTMLButtonElement>) {
    // The button often sits next to a Link card — don't navigate when clicked.
    e.preventDefault();
    e.stopPropagation();

    const what = label ?? conversationId.slice(0, 8);
    const msg = withFiles
      ? `Delete "${what}" and its generated image files? This cannot be undone.`
      : `Delete "${what}"? This cannot be undone.`;
    if (!window.confirm(msg)) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label="Delete conversation"
        title="Delete conversation"
        className={
          className ??
          "rounded border border-transparent px-2 py-1 text-xs text-neutral-500 hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:border-red-800"
        }
      >
        {busy ? "deleting…" : "delete"}
      </button>
      {error && <span className="mt-0.5 text-[10px] text-red-600">{error}</span>}
    </span>
  );
}
