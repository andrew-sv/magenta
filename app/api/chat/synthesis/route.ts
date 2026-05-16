import { z } from "zod";
import { runSynthesis } from "@/lib/orchestrators/synthesis";
import type { SynthesisEvent } from "@/lib/sse/events";
import { sseResponse } from "@/lib/sse/writer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  conversationId: z.string().uuid(),
  memberModelIds: z.array(z.string().min(1)).min(2).max(6),
  synthesizerModelId: z.string().min(1),
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

  return sseResponse<SynthesisEvent>(request, (emit, signal) =>
    runSynthesis(parsed.data, emit, signal),
  );
}
