import Link from "next/link";
import { DeleteConversationButton } from "@/components/DeleteConversationButton";
import { listChatHistory, type ChatHistoryEntry } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

const MODE_LABEL: Record<ChatHistoryEntry["mode"], string> = {
  single: "Single",
  fanout: "Fanout",
  loop: "Loop",
  council: "Council",
  synthesis: "Synthesis",
  imagine: "Imagine",
  animate: "Animate",
  music: "Music",
};

const MODE_ORDER: ChatHistoryEntry["mode"][] = [
  "single",
  "fanout",
  "loop",
  "council",
  "synthesis",
];

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n).trimEnd() + "…";
}

export default async function ChatsHistoryPage() {
  const rows = await listChatHistory(500);

  const byMode = new Map<ChatHistoryEntry["mode"], ChatHistoryEntry[]>();
  for (const r of rows) {
    const list = byMode.get(r.mode) ?? [];
    list.push(r);
    byMode.set(r.mode, list);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Chat history</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Past text conversations, grouped by mode. (Imagine history lives at{" "}
            <Link href="/imagine/history" className="text-magenta-600 hover:underline">
              /imagine/history
            </Link>
            .)
          </p>
        </div>
        <Link
          href="/"
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:border-magenta-400 dark:border-neutral-700"
        >
          ← Modes
        </Link>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No past text conversations yet.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {MODE_ORDER.map((mode) => {
            const list = byMode.get(mode);
            if (!list || list.length === 0) return null;
            return (
              <section key={mode} className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  {MODE_LABEL[mode]} <span className="font-normal">({list.length})</span>
                </h2>
                <ul className="flex flex-col gap-2">
                  {list.map((c) => (
                    <li
                      key={c.conversationId}
                      className="group flex items-stretch gap-1 rounded-lg border border-neutral-200 bg-white shadow-sm transition hover:border-magenta-400 dark:border-neutral-800 dark:bg-neutral-900"
                    >
                      <Link
                        href={`/chat/${c.conversationId}`}
                        className="flex flex-1 flex-col gap-1 p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium">
                            {c.title || truncate(c.firstUserPrompt, 80) || "Untitled"}
                          </span>
                          <span className="text-xs text-neutral-500">
                            {new Date(c.updatedAt).toLocaleString()}
                          </span>
                        </div>
                        {c.lastAssistantSnippet && (
                          <p className="line-clamp-2 text-xs text-neutral-600 dark:text-neutral-400">
                            {truncate(c.lastAssistantSnippet, 220)}
                          </p>
                        )}
                        <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                          {c.messageCount} message{c.messageCount === 1 ? "" : "s"}
                        </span>
                      </Link>
                      <div className="flex items-start p-2">
                        <DeleteConversationButton
                          conversationId={c.conversationId}
                          label={c.title || truncate(c.firstUserPrompt, 60) || "Untitled"}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
