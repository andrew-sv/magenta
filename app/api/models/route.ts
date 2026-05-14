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

export async function GET() {
  const installed = await getInstalledOllamaModels();

  const entries: ModelEntry[] = MODEL_CATALOG.map((m) => {
    if (m.providerId === "ollama") {
      if (installed === null) {
        return {
          ...m,
          available: false,
          unavailableReason: "Ollama is not reachable at OLLAMA_BASE_URL.",
        };
      }
      const ok = installed.has(m.modelName) || installed.has(`${m.modelName}:latest`);
      return ok
        ? { ...m, available: true }
        : { ...m, available: false, unavailableReason: `Run \`ollama pull ${m.modelName}\`` };
    }
    if (m.providerId === "anthropic") {
      // We can't cheaply probe Claude auth without making a billed call.
      // Mark available; surface auth errors on first use.
      return { ...m, available: true };
    }
    return { ...m, available: false, unavailableReason: "Provider not wired up yet." };
  });

  return NextResponse.json({ models: entries });
}
