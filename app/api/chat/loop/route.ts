import { z } from "zod";
import { runLoop } from "@/lib/orchestrators/loop";
import type { LoopEvent } from "@/lib/sse/events";
import { sseResponse } from "@/lib/sse/writer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  conversationId: z.string().uuid(),
  modelAId: z.string().min(1),
  modelBId: z.string().min(1),
  userContent: z.string().min(1),
  maxRounds: z.number().int().min(1).max(20).optional(),
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

  return sseResponse<LoopEvent>(request, (emit, signal) =>
    runLoop(parsed.data, emit, signal),
  );
}
