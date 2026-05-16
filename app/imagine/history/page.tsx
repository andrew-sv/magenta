import Link from "next/link";
import { findModel } from "@/lib/ai/catalog";
import { listImagineGallery, type ImagineGalleryEntry } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

type Group = {
  conversationId: string;
  conversationTitle: string;
  createdAt: Date;
  entries: ImagineGalleryEntry[];
};

function groupByConversation(rows: ImagineGalleryEntry[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const g = groups.get(r.conversationId);
    if (g) {
      g.entries.push(r);
      if (r.createdAt < g.createdAt) g.createdAt = r.createdAt;
    } else {
      groups.set(r.conversationId, {
        conversationId: r.conversationId,
        conversationTitle: r.conversationTitle,
        createdAt: r.createdAt,
        entries: [r],
      });
    }
  }
  return Array.from(groups.values()).sort(
    (a, b) =>
      Math.max(...b.entries.map((e) => e.createdAt.getTime())) -
      Math.max(...a.entries.map((e) => e.createdAt.getTime())),
  );
}

function modelLabel(modelId: string | null): string {
  if (!modelId) return "?";
  return findModel(modelId)?.label ?? modelId;
}

export default async function ImagineHistoryPage() {
  const rows = await listImagineGallery(500);
  const groups = groupByConversation(rows);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Imagine history</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Every generated image from past Imagine sessions, grouped by conversation.
          </p>
        </div>
        <Link
          href="/"
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:border-magenta-400 dark:border-neutral-700"
        >
          ← Modes
        </Link>
      </header>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No imagine sessions yet. Start one from the home page.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <section
              key={g.conversationId}
              className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <Link
                  href={`/chat/${g.conversationId}`}
                  className="text-sm font-medium text-magenta-600 hover:underline"
                >
                  {g.conversationTitle || "Untitled session"}
                </Link>
                <span className="text-xs text-neutral-500">
                  {new Date(
                    Math.max(...g.entries.map((e) => e.createdAt.getTime())),
                  ).toLocaleString()}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {g.entries.map((e) => {
                  const img = e.attachments.find((a) => a.kind === "image");
                  if (!img) return null;
                  return (
                    <Link
                      key={e.assistantMessageId}
                      href={`/chat/${e.conversationId}`}
                      className="group flex flex-col gap-2"
                    >
                      <div className="relative aspect-square overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-950">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={img.path}
                          alt={e.prompt}
                          className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                        />
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="line-clamp-2 text-xs text-neutral-700 dark:text-neutral-300">
                          {e.prompt || "(no prompt)"}
                        </span>
                        <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                          {modelLabel(e.modelId)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
