import { z } from "zod";

const Schema = z.object({
  DATABASE_URL: z.string().url(),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_MODE: z.enum(["native", "openai"]).default("native"),
  COMFYUI_BASE_URL: z.string().url().default("http://127.0.0.1:8000"),
  DEFAULT_LOOP_ROUNDS: z.coerce.number().int().min(1).max(20).default(3),
  MAGENTA_LOCAL_ONLY: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const parsed = Schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}\n\nSee .env.example.`);
}

export const env = parsed.data;
export type Env = typeof env;
