import { NextResponse } from "next/server";
import { z } from "zod";
import { createConversation, listConversations } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

const CreateBody = z.object({
  mode: z.enum(["single", "fanout", "loop", "council", "synthesis", "imagine"]),
  title: z.string().max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export async function GET() {
  const rows = await listConversations();
  return NextResponse.json({ conversations: rows });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const row = await createConversation({
    mode: parsed.data.mode,
    title: parsed.data.title ?? "",
    config: parsed.data.config ?? {},
  });
  return NextResponse.json({ conversation: row }, { status: 201 });
}
