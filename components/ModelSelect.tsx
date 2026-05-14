"use client";

import { useEffect, useState } from "react";
import type { ModelDescriptor } from "@/lib/ai/catalog";

type ModelEntry = ModelDescriptor & {
  available: boolean;
  unavailableReason?: string;
};

type Props = {
  value: string | null;
  onChange: (id: string) => void;
  label?: string;
  /** Hide models that aren't available. Defaults to false (shows them disabled). */
  hideUnavailable?: boolean;
};

export function ModelSelect({ value, onChange, label, hideUnavailable = false }: Props) {
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((r) => r.json())
      .then((data: { models: ModelEntry[] }) => {
        if (!cancelled) setModels(data.models);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <span className="text-sm text-red-500">Failed to load models: {error}</span>;
  if (!models) return <span className="text-sm text-neutral-500">Loading models…</span>;

  const visible = hideUnavailable ? models.filter((m) => m.available) : models;

  return (
    <label className="inline-flex items-center gap-2 text-sm">
      {label && <span className="text-neutral-600 dark:text-neutral-400">{label}</span>}
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        <option value="" disabled>
          Select a model…
        </option>
        {visible.map((m) => (
          <option key={m.id} value={m.id} disabled={!m.available} title={m.unavailableReason}>
            {m.label}
            {!m.available ? " (unavailable)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
