import { notFound } from "next/navigation";
import { AnimateView } from "@/components/AnimateView";
import { CouncilView } from "@/components/CouncilView";
import { FanoutView } from "@/components/FanoutView";
import { ImagineView } from "@/components/ImagineView";
import { LoopView } from "@/components/LoopView";
import { MusicView } from "@/components/MusicView";
import { SingleChatView } from "@/components/SingleChatView";
import { SynthesisView } from "@/components/SynthesisView";
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
      return <SynthesisView conversation={conversation} />;
    case "imagine":
      return <ImagineView conversation={conversation} />;
    case "animate":
      return <AnimateView conversation={conversation} />;
    case "music":
      return <MusicView conversation={conversation} />;
  }
}
