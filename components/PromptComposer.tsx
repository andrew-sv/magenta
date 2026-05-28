"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";

/** An image attachment ready to send: base64 payload (no `data:` prefix) + mime. */
export type ComposerImage = {
  dataBase64: string;
  mime: string;
  name: string;
};

type Props = {
  onSubmit: (text: string, images?: ComposerImage[]) => void;
  onAbort?: () => void;
  busy?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Show the image-attach control. Gate this on the selected model's vision capability. */
  allowImages?: boolean;
};

const MAX_IMAGES = 4;

export function PromptComposer({
  onSubmit,
  onAbort,
  busy,
  placeholder,
  disabled,
  allowImages,
}: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSend = (text.trim().length > 0 || images.length > 0) && !busy && !disabled;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    onSubmit(text.trim(), images.length ? images : undefined);
    setText("");
    setImages([]);
  }

  async function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    // Reset the input so picking the same file again re-fires onChange.
    e.target.value = "";
    const room = MAX_IMAGES - images.length;
    const picked = await Promise.all(files.slice(0, room).map(readImage));
    if (picked.length) setImages((prev) => [...prev, ...picked]);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-neutral-200 bg-white px-6 py-4 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:${img.mime};base64,${img.dataBase64}`}
                  alt={img.name}
                  className="h-16 w-16 rounded-lg border border-neutral-300 object-cover dark:border-neutral-700"
                />
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-xs text-white shadow hover:bg-neutral-700"
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3">
          {allowImages && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFiles}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || images.length >= MAX_IMAGES}
                title={images.length >= MAX_IMAGES ? `Up to ${MAX_IMAGES} images` : "Attach image"}
                className="rounded-lg border border-neutral-300 px-3 py-3 text-sm text-neutral-600 shadow-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                📎
              </button>
            </>
          )}
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
              disabled={!canSend}
              className="rounded-lg bg-magenta-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-magenta-700 disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function readImage(file: File): Promise<ComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is a data URL: "data:<mime>;base64,<payload>"
      const comma = result.indexOf(",");
      resolve({
        dataBase64: result.slice(comma + 1),
        mime: file.type || "image/png",
        name: file.name,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
