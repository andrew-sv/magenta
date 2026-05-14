import type { AnyChatEvent } from "./events";

/**
 * POSTs to an SSE route and yields parsed events. The server uses
 * `text/event-stream` framing; we accept either bare-JSON lines or full
 * `data: ` prefixed lines.
 */
export async function* postSse<E extends AnyChatEvent>(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncIterable<E> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`SSE request failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by \n\n.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          const payload = line.startsWith("data:") ? line.slice(5).trimStart() : line;
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as E;
          } catch {
            // Skip malformed line; the writer always emits valid JSON.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
