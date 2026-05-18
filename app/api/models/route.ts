import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { MODEL_CATALOG, type ModelDescriptor } from "@/lib/ai/catalog";

export const dynamic = "force-dynamic";

type ModelEntry = ModelDescriptor & {
  available: boolean;
  unavailableReason?: string;
};

async function getInstalledOllamaModels(): Promise<Set<string> | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${env.OLLAMA_BASE_URL}/api/tags`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = new Set<string>();
    for (const m of data.models ?? []) {
      if (!m.name) continue;
      names.add(m.name);
      // Ollama tags are often "llama3.1:latest"; allow bare-name match too.
      const bare = m.name.split(":")[0];
      if (bare) names.add(bare);
    }
    return names;
  } catch {
    return null;
  }
}

async function getInstalledComfyCheckpoints(): Promise<Set<string> | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(
      `${env.COMFYUI_BASE_URL}/object_info/CheckpointLoaderSimple`,
      { signal: controller.signal, cache: "no-store" },
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      CheckpointLoaderSimple?: {
        input?: { required?: { ckpt_name?: [string[]] } };
      };
    };
    const list =
      data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    return new Set(list);
  } catch {
    return null;
  }
}

export async function GET() {
  const [installedOllama, installedComfy] = await Promise.all([
    getInstalledOllamaModels(),
    getInstalledComfyCheckpoints(),
  ]);

  const entries: ModelEntry[] = MODEL_CATALOG.map((m) => {
    if (m.providerId === "ollama") {
      if (installedOllama === null) {
        return {
          ...m,
          available: false,
          unavailableReason: "Ollama is not reachable at OLLAMA_BASE_URL.",
        };
      }
      const ok =
        installedOllama.has(m.modelName) ||
        installedOllama.has(`${m.modelName}:latest`);
      return ok
        ? { ...m, available: true }
        : {
            ...m,
            available: false,
            unavailableReason: `Run \`ollama pull ${m.modelName}\``,
          };
    }
    if (m.providerId === "anthropic") {
      // We can't cheaply probe Claude auth without making a billed call.
      // Mark available; surface auth errors on first use.
      return { ...m, available: true };
    }
    if (m.providerId === "google") {
      return env.GOOGLE_GENERATIVE_AI_API_KEY
        ? { ...m, available: true }
        : {
            ...m,
            available: false,
            unavailableReason: "Set GOOGLE_GENERATIVE_AI_API_KEY in .env",
          };
    }
    if (m.providerId === "comfyui") {
      if (installedComfy === null) {
        return {
          ...m,
          available: false,
          unavailableReason: "ComfyUI is not reachable at COMFYUI_BASE_URL.",
        };
      }
      return installedComfy.has(m.modelName)
        ? { ...m, available: true }
        : {
            ...m,
            available: false,
            unavailableReason: `Drop ${m.modelName} into ComfyUI/models/checkpoints/`,
          };
    }
    return { ...m, available: false, unavailableReason: "Provider not wired up yet." };
  });

  return NextResponse.json({ models: entries });
}
