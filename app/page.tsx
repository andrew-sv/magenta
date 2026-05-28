import Link from "next/link";
import { ModePicker } from "@/components/ModePicker";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Magenta</h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          Local multi-agent chat. Pick a mode to start a conversation.
        </p>
        <nav className="mt-2 flex gap-4 text-sm">
          <Link href="/chats/history" className="text-magenta-600 hover:underline">
            Chat history
          </Link>
          <Link href="/imagine/history" className="text-magenta-600 hover:underline">
            Imagine history
          </Link>
          <Link href="/animate/history" className="text-magenta-600 hover:underline">
            Animate history
          </Link>
          <Link href="/music/history" className="text-magenta-600 hover:underline">
            Music history
          </Link>
        </nav>
      </header>
      <ModePicker />
    </main>
  );
}
