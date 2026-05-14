import type { AnyChatEvent } from "./events";

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Disable proxy buffering (nginx and friends).
  "X-Accel-Buffering": "no",
};

export type Emit<E extends AnyChatEvent> = (event: E) => void;

/**
 * Build a Response whose body is an SSE stream. The orchestrator is a function
 * that receives a typed `emit` and runs to completion (or abort). The writer
 * handles framing, JSON encoding, the trailing `done` event, and the abort
 * signal plumbed in from the incoming Request.
 */
export function sseResponse<E extends AnyChatEvent>(
  request: Request,
  orchestrator: (emit: Emit<E>, signal: AbortSignal) => Promise<void>,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const emit: Emit<AnyChatEvent> = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Propagate client disconnect.
      const onAbort = () => {
        close();
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      try {
        await orchestrator(emit as Emit<E>, request.signal);
        emit({ type: "done" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "error", message });
        emit({ type: "done" });
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
