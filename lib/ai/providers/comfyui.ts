import { env } from "../../env";
import type {
  AnimationEvent,
  AnimationGenParams,
  AnimationProvider,
  AudioEvent,
  AudioGenParams,
  AudioProvider,
  ImageEvent,
  ImageGenParams,
  ImageProvider,
} from "../types";
import {
  ANIMATION_WORKFLOWS,
  AUDIO_WORKFLOWS,
  WORKFLOWS,
  type AnimationWorkflowName,
  type AudioWorkflowName,
  type WorkflowName,
} from "../workflows";

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
    let wasInterrupted = false;
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
          // ComfyUI's /interrupt is global — it can cancel our prompt mid-run
          // even when our own signal hasn't aborted (e.g. another tile in the
          // same conversation aborted and called /interrupt). Mark it so we
          // can surface it as an error instead of silently completing.
          wasInterrupted = true;
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
      if (wasInterrupted) {
        throw new Error(
          "ComfyUI execution was interrupted (likely by another tile aborting — /interrupt is global)",
        );
      }

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

class ComfyUIAnimationProvider implements AnimationProvider {
  readonly providerId = "comfyui" as const;

  async *generate(params: AnimationGenParams): AsyncIterable<AnimationEvent> {
    const builder = ANIMATION_WORKFLOWS[params.workflow as AnimationWorkflowName];
    if (!builder) {
      throw new Error(`Unknown ComfyUI animation workflow: ${params.workflow}`);
    }

    const clientId = crypto.randomUUID();
    const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
    const workflow = builder({
      ckptName: params.modelName,
      motionModule: params.motionModule,
      motionScale: params.motionScale,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt ?? "",
      width: params.width,
      height: params.height,
      steps: params.steps,
      cfg: params.cfg ?? 7.5,
      seed,
      frames: params.frames,
      fps: params.fps,
    });

    const queue: AnimationEvent[] = [];
    let wsClosed = false;
    let executionDone = false;
    let wasInterrupted = false;
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
        // AnimateDiff doesn't emit usable previews; ignore binary frames.
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
          wasInterrupted = true;
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
      if (wasInterrupted) {
        throw new Error(
          "ComfyUI execution was interrupted (likely by another tile aborting — /interrupt is global)",
        );
      }

      const histRes = await fetch(httpUrl(`/history/${promptId}`), { signal: params.signal });
      if (!histRes.ok) {
        throw new Error(`ComfyUI /history/${promptId} ${histRes.status}`);
      }
      const hist = (await histRes.json()) as Record<string, ComfyHistoryEntry>;
      const entry = hist[promptId];
      if (!entry) throw new Error(`ComfyUI: no history entry for prompt ${promptId}`);

      // ADE_AnimateDiffCombine emits its file under outputs.gifs (not .images),
      // but older variants surface it under .images too. Walk both.
      type ComfyFileRef = { filename: string; subfolder: string; type: string };
      const gifFiles: ComfyFileRef[] = [];
      for (const nodeOutput of Object.values(entry.outputs ?? {})) {
        const out = nodeOutput as Record<string, unknown>;
        for (const key of ["gifs", "images"] as const) {
          const arr = out[key];
          if (Array.isArray(arr)) {
            for (const f of arr) {
              if (
                f &&
                typeof f === "object" &&
                typeof (f as ComfyFileRef).filename === "string" &&
                (f as ComfyFileRef).filename.toLowerCase().endsWith(".gif")
              ) {
                gifFiles.push(f as ComfyFileRef);
              }
            }
          }
        }
      }
      if (gifFiles.length === 0) {
        throw new Error(
          "ComfyUI: AnimateDiff workflow completed but no .gif file appeared in history outputs",
        );
      }

      for (const gif of gifFiles) {
        const u = new URL(httpUrl("/view"));
        u.searchParams.set("filename", gif.filename);
        u.searchParams.set("subfolder", gif.subfolder ?? "");
        u.searchParams.set("type", gif.type ?? "output");
        const fileRes = await fetch(u.toString(), { signal: params.signal });
        if (!fileRes.ok) {
          throw new Error(`ComfyUI /view ${fileRes.status} for ${gif.filename}`);
        }
        const buf = Buffer.from(await fileRes.arrayBuffer());
        yield {
          type: "gif",
          mime: "image/gif",
          dataBase64: buf.toString("base64"),
          width: params.width,
          height: params.height,
          frames: params.frames,
          fps: params.fps,
          seed,
        };
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

export const comfyUIAnimationProvider = new ComfyUIAnimationProvider();

const AUDIO_MIME: Record<string, string> = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
  ogg: "audio/ogg",
};

class ComfyUIAudioProvider implements AudioProvider {
  readonly providerId = "comfyui" as const;

  async *generate(params: AudioGenParams): AsyncIterable<AudioEvent> {
    const builder = AUDIO_WORKFLOWS[params.workflow as AudioWorkflowName];
    if (!builder) {
      throw new Error(`Unknown ComfyUI audio workflow: ${params.workflow}`);
    }

    const clientId = crypto.randomUUID();
    const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
    const workflow = builder({
      ckptName: params.modelName,
      prompt: params.prompt,
      lyrics: params.lyrics ?? "",
      negativePrompt: params.negativePrompt ?? "",
      durationSeconds: params.durationSeconds,
      steps: params.steps,
      cfg: params.cfg ?? 5,
      seed,
    });

    const queue: AudioEvent[] = [];
    let wsClosed = false;
    let executionDone = false;
    let wasInterrupted = false;
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
        // Audio workflows don't emit usable previews; ignore binary frames.
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
          wasInterrupted = true;
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
      if (wasInterrupted) {
        throw new Error(
          "ComfyUI execution was interrupted (likely by another tile aborting — /interrupt is global)",
        );
      }

      const histRes = await fetch(httpUrl(`/history/${promptId}`), { signal: params.signal });
      if (!histRes.ok) {
        throw new Error(`ComfyUI /history/${promptId} ${histRes.status}`);
      }
      const hist = (await histRes.json()) as Record<string, ComfyHistoryEntry>;
      const entry = hist[promptId];
      if (!entry) throw new Error(`ComfyUI: no history entry for prompt ${promptId}`);

      // SaveAudio surfaces files under outputs.<node>.audio (some builds use
      // .images for the waveform PNG too — we only want the audio array).
      type ComfyFileRef = { filename: string; subfolder: string; type: string };
      const audioFiles: ComfyFileRef[] = [];
      for (const nodeOutput of Object.values(entry.outputs ?? {})) {
        const arr = (nodeOutput as Record<string, unknown>).audio;
        if (Array.isArray(arr)) {
          for (const f of arr) {
            if (
              f &&
              typeof f === "object" &&
              typeof (f as ComfyFileRef).filename === "string"
            ) {
              audioFiles.push(f as ComfyFileRef);
            }
          }
        }
      }
      if (audioFiles.length === 0) {
        throw new Error(
          "ComfyUI: audio workflow completed but no audio file appeared in history outputs",
        );
      }

      for (const audio of audioFiles) {
        const u = new URL(httpUrl("/view"));
        u.searchParams.set("filename", audio.filename);
        u.searchParams.set("subfolder", audio.subfolder ?? "");
        u.searchParams.set("type", audio.type ?? "output");
        const fileRes = await fetch(u.toString(), { signal: params.signal });
        if (!fileRes.ok) {
          throw new Error(`ComfyUI /view ${fileRes.status} for ${audio.filename}`);
        }
        const buf = Buffer.from(await fileRes.arrayBuffer());
        const ext = audio.filename.split(".").pop()?.toLowerCase() ?? "";
        yield {
          type: "audio",
          mime: AUDIO_MIME[ext] ?? "application/octet-stream",
          dataBase64: buf.toString("base64"),
          durationSeconds: params.durationSeconds,
          seed,
        };
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

export const comfyUIAudioProvider = new ComfyUIAudioProvider();
