import { z } from "zod";
import { runImagine } from "@/lib/orchestrators/imagine";
import type { ImagineEvent } from "@/lib/sse/events";
import { sseResponse } from "@/lib/sse/writer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  conversationId: z.string().uuid(),
  modelId: z.string().min(1),
  tileKey: z.string().min(1),
  clientMessageId: z.string().min(1),
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
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

  return sseResponse<ImagineEvent>(request, (emit, signal) =>
    runImagine(parsed.data, emit, signal),
  );
}
