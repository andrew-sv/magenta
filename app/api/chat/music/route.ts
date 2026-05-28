import { z } from "zod";
import { runMusic } from "@/lib/orchestrators/music";
import type { MusicEvent } from "@/lib/sse/events";
import { sseResponse } from "@/lib/sse/writer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  conversationId: z.string().uuid(),
  modelId: z.string().min(1),
  tileKey: z.string().min(1),
  clientMessageId: z.string().min(1),
  prompt: z.string().min(1),
  lyrics: z.string().optional(),
  negativePrompt: z.string().optional(),
  durationSeconds: z.number().min(1).max(300).optional(),
  steps: z.number().int().min(1).max(200).optional(),
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

  return sseResponse<MusicEvent>(request, (emit, signal) =>
    runMusic(parsed.data, emit, signal),
  );
}
