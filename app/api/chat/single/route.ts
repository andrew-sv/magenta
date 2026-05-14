import { z } from "zod";
import { runSingle } from "@/lib/orchestrators/single";
import type { SingleEvent } from "@/lib/sse/events";
import { sseResponse } from "@/lib/sse/writer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  conversationId: z.string().uuid(),
  modelId: z.string().min(1),
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

  return sseResponse<SingleEvent>(request, (emit, signal) =>
    runSingle(parsed.data, emit, signal),
  );
}
