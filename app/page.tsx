import { ModePicker } from "@/components/ModePicker";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Magenta</h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          Local multi-agent chat. Pick a mode to start a conversation.
        </p>
      </header>
      <ModePicker />
    </main>
  );
}
