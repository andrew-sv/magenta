import { NextResponse } from "next/server";
import {
  averagesByTarget,
  getConversation,
  listMessages,
  listScores,
  updateConversationTitle,
} from "@/lib/db/queries";
import { z } from "zod";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const conversation = await getConversation(id);
  if (!conversation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [messages, scores, averages] = await Promise.all([
    listMessages(id),
    listScores(id),
    averagesByTarget(id),
  ]);
  return NextResponse.json({ conversation, messages, scores, averages });
}

const PatchBody = z.object({
  title: z.string().max(200),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await updateConversationTitle(id, parsed.data.title);
  return NextResponse.json({ ok: true });
}
