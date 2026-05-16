import { env } from "../../env";
import type { ImageEvent, ImageGenParams, ImageProvider } from "../types";
import { WORKFLOWS, type WorkflowName } from "../workflows";

const httpUrl = (path: string) => `${env.COMFYUI_BASE_URL}${path}`;
const wsUrl = (clientId: string) =>
  `${env.COMFYUI_BASE_URL.replace(/^http/, "ws")}/ws?clientId=${clientId}`;

type ComfyHistoryEntry = {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
};

class ComfyUIProvider implements ImageProvider {
  readonly providerId = "comfyui" as const;

  async *generate(params: ImageGenParams): AsyncIterable<ImageEvent> {
    const builder = WORKFLOWS[params.workflow as WorkflowName];
    if (!builder) {
      throw new Error(`Unknown ComfyUI workflow: ${params.workflow}`);
    }

    const clientId = crypto.randomUUID();
    const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
    const workflow = builder({
      ckptName: params.modelName,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt ?? "",
      width: params.width,
      height: params.height,
      steps: params.steps,
      cfg: params.cfg ?? 1,
      seed,
    });

    const queue: ImageEvent[] = [];
    let wsClosed = false;
    let executionDone = false;
    let wsError: Error | null = null;
    let promptId: string | null = null;
    let resolveNext: (() => void) | null = null;
    const wake = () => {
      const r = resolveNext;
      resolveNext = null;
      r?.();
    };

    const ws = new WebSocket(wsUrl(clientId));
    ws.binaryType = "arraybuffer";

    ws.addEventListener("message", (evt: MessageEvent) => {
      if (evt.data instanceof ArrayBuffer) {
        if (evt.data.byteLength < 8) return;
        const view = new DataView(evt.data);
        const eventType = view.getUint32(0);
        if (eventType !== 1) return; // 1 = preview image
        const imageType = view.getUint32(4);
        const mime = imageType === 2 ? "image/png" : "image/jpeg";
        const bytes = new Uint8Array(evt.data, 8);
        queue.push({
          type: "preview",
          mime,
          dataBase64: Buffer.from(bytes).toString("base64"),
        });
        wake();
        return;
      }
      try {
        const msg = JSON.parse(String(evt.data)) as {
          type: string;
          data?: Record<string, unknown>;
        };
        const data = msg.data ?? {};
        const dataPromptId = data.prompt_id as string | undefined;
        if (promptId && dataPromptId && dataPromptId !== promptId) return;

        if (msg.type === "progress" && typeof data.value === "number" && typeof data.max === "number") {
          queue.push({ type: "progress", current: data.value, total: data.max });
          wake();
        } else if (msg.type === "executing") {
          if (data.node === null && dataPromptId === promptId) {
            executionDone = true;
            wake();
          }
        } else if (msg.type === "execution_error") {
          wsError = new Error(`ComfyUI execution error: ${JSON.stringify(data)}`);
          wake();
        } else if (msg.type === "execution_interrupted") {
          executionDone = true;
          wake();
        }
      } catch {
        // ignore non-JSON
      }
    });
    ws.addEventListener("close", () => {
      wsClosed = true;
      wake();
    });
    ws.addEventListener("error", () => {
      wsError = new Error("ComfyUI WebSocket error");
      wake();
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("error", onErr);
        resolve();
      };
      const onErr = () => {
        ws.removeEventListener("open", onOpen);
        reject(new Error(`Failed to open ComfyUI WebSocket at ${wsUrl(clientId)}`));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onErr, { once: true });
    });

    const onAbort = () => {
      void fetch(httpUrl("/interrupt"), { method: "POST" }).catch(() => undefined);
    };
    params.signal.addEventListener("abort", onAbort);

    try {
      const queueRes = await fetch(httpUrl("/prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        signal: params.signal,
      });
      if (!queueRes.ok) {
        const body = await queueRes.text();
        throw new Error(`ComfyUI /prompt ${queueRes.status}: ${body}`);
      }
      const queued = (await queueRes.json()) as { prompt_id: string; number: number };
      promptId = queued.prompt_id;
      yield { type: "queued", position: queued.number };

      while (!executionDone && !wsError && !wsClosed) {
        while (queue.length) {
          const e = queue.shift();
          if (e) yield e;
        }
        if (executionDone || wsError || wsClosed) break;
        if (params.signal.aborted) break;
        await new Promise<void>((r) => {
          resolveNext = r;
        });
      }
      while (queue.length) {
        const e = queue.shift();
        if (e) yield e;
      }
      if (wsError) throw wsError;
      if (params.signal.aborted) return;

      const histRes = await fetch(httpUrl(`/history/${promptId}`), { signal: params.signal });
      if (!histRes.ok) {
        throw new Error(`ComfyUI /history/${promptId} ${histRes.status}`);
      }
      const hist = (await histRes.json()) as Record<string, ComfyHistoryEntry>;
      const entry = hist[promptId];
      if (!entry) throw new Error(`ComfyUI: no history entry for prompt ${promptId}`);

      for (const nodeOutput of Object.values(entry.outputs ?? {})) {
        for (const img of nodeOutput.images ?? []) {
          const u = new URL(httpUrl("/view"));
          u.searchParams.set("filename", img.filename);
          u.searchParams.set("subfolder", img.subfolder ?? "");
          u.searchParams.set("type", img.type ?? "output");
          const imgRes = await fetch(u.toString(), { signal: params.signal });
          if (!imgRes.ok) {
            throw new Error(`ComfyUI /view ${imgRes.status} for ${img.filename}`);
          }
          const buf = Buffer.from(await imgRes.arrayBuffer());
          yield {
            type: "image",
            mime: img.filename.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "image/png",
            dataBase64: buf.toString("base64"),
            width: params.width,
            height: params.height,
            seed,
          };
        }
      }
    } finally {
      params.signal.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }
}

export const comfyUIProvider = new ComfyUIProvider();
