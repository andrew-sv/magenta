import { z } from "zod";
import { runFanout } from "@/lib/orchestrators/fanout";
import type { FanoutEvent } from "@/lib/sse/events";
import { sseResponse } from "@/lib/sse/writer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  conversationId: z.string().uuid(),
  modelId: z.string().min(1),
  paneKey: z.string().min(1),
  clientMessageId: z.string().min(1),
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

  return sseResponse<FanoutEvent>(request, (emit, signal) =>
    runFanout(parsed.data, emit, signal),
  );
}
