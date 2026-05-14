import { z } from "zod";
import { runCouncil } from "@/lib/orchestrators/council";
import type { CouncilEvent } from "@/lib/sse/events";
import { sseResponse } from "@/lib/sse/writer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  conversationId: z.string().uuid(),
  memberModelIds: z.array(z.string().min(1)).min(2).max(6),
  userContent: z.string().min(1),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.flatten() }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  return sseResponse<CouncilEvent>(request, async (emit, signal) => {
    await runCouncil(parsed.data, emit, signal);
  });
}
