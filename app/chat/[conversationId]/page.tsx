import { notFound } from "next/navigation";
import { CouncilView } from "@/components/CouncilView";
import { FanoutView } from "@/components/FanoutView";
import { LoopView } from "@/components/LoopView";
import { SingleChatView } from "@/components/SingleChatView";
import { getConversation } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const conversation = await getConversation(conversationId);
  if (!conversation) notFound();

  switch (conversation.mode) {
    case "single":
      return <SingleChatView conversation={conversation} />;
    case "fanout":
      return <FanoutView conversation={conversation} />;
    case "loop":
      return <LoopView conversation={conversation} />;
    case "council":
      return <CouncilView conversation={conversation} />;
    case "synthesis":
      return (
        <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-3 p-8 text-center">
          <h1 className="text-2xl font-semibold">{conversation.mode} mode</h1>
          <p className="text-neutral-600 dark:text-neutral-400">
            This mode hasn’t been wired up yet. It’s coming.
          </p>
          <a
            href="/"
            className="rounded bg-magenta-600 px-3 py-2 text-sm font-medium text-white hover:bg-magenta-700"
          >
            Back to modes
          </a>
        </main>
      );
  }
}
