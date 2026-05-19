import { z } from "zod";
import { runAnimate } from "@/lib/orchestrators/animate";
import type { AnimateEvent } from "@/lib/sse/events";
import { sseResponse } from "@/lib/sse/writer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  conversationId: z.string().uuid(),
  modelId: z.string().min(1),
  tileKey: z.string().min(1),
  clientMessageId: z.string().min(1),
  prompt: z.string().min(1),
  motionScale: z.number().min(0).max(4),
  negativePrompt: z.string().optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  frames: z.number().int().min(1).max(64).optional(),
  fps: z.number().int().min(1).max(24).optional(),
  seed: z.number().int().optional(),
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

  return sseResponse<AnimateEvent>(request, (emit, signal) =>
    runAnimate(parsed.data, emit, signal),
  );
}
