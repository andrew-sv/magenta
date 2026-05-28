# Magenta

Local multi-agent chat. Talk to one model, several models in parallel, two models in a question/answer loop, a council of models that score each other and (optionally) synthesize a combined answer, fan out **image generation** across multiple local diffusion checkpoints, animate short clips, or generate **music and songs**.

Runs entirely on your machine. Models are reached through:

- **Anthropic Claude** via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), authenticated against your **Claude Pro / Max subscription** (no API key needed — calls bill against your subscription quota)
- **Ollama** for local text/vision models
- **ComfyUI** for local image, animation, and music generation (SDXL, FLUX, AnimateDiff, ACE-Step, Stable Audio)

Designed so adding **OpenAI**, **Gemini**, and **xAI** later is a drop-in change.

## Modes

| Mode          | What it does                                                                                |
| ------------- | ------------------------------------------------------------------------------------------- |
| **Single**    | Pick one model, normal chat.                                                                |
| **Fanout**    | Two or more panes side-by-side, each pinned to a different model. One prompt → all panes.   |
| **Loop**      | Pick Model A (answerer) and Model B (questioner). You write one prompt; the pair takes N rounds (default 3). |
| **Council**   | 3–4 models answer the same prompt in parallel. Each model scores the others 0–100. Averages shown per response. |
| **Synthesis** | Council + a final synthesizer model that combines all responses into one answer.            |
| **Imagine**   | Two or more image checkpoints, same prompt, side-by-side tiles. Powered by a local ComfyUI server. |
| **Animate**   | AnimateDiff GIFs from one prompt at low and high motion, side-by-side. Powered by ComfyUI.  |
| **Music**     | ACE-Step song (style + optional lyrics) and Stable Audio instrumental from one prompt, side-by-side. Powered by ComfyUI. |

Past sessions are browsable at `/chats/history` (text modes) and `/imagine/history`, `/animate/history`, `/music/history` (media galleries).

## Requirements

- **Node 20+**
- **pnpm** (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Postgres 16** running locally (`brew install postgresql@16 && brew services start postgresql@16` on macOS)
- **Ollama** running natively if you want local models (`brew install ollama` on macOS, then `ollama serve`)
- **Claude Code CLI** installed and logged into your Pro/Max subscription (`claude login`) if you want Claude models
- **ComfyUI** running locally if you want Imagine / Animate / Music mode. The [ComfyUI Desktop app](https://www.comfy.org/download) binds to `127.0.0.1:8000`; the CLI distribution typically binds to `:8188`. Drop checkpoints into `models/checkpoints/`. By mode:
  - **Imagine** — image checkpoints (SDXL Turbo, FLUX schnell, …) in `models/checkpoints/`.
  - **Animate** — an SD1.5 checkpoint plus an AnimateDiff motion module in `models/animatediff_models/`.
  - **Music** — `ace_step_v1_3.5b.safetensors` (all-in-one) in `models/checkpoints/` for the song tile; the instrumental tile additionally needs `stable_audio_open_1.0.safetensors` in `models/checkpoints/` and `t5_base.safetensors` in `models/text_encoders/` (Stable Audio Open is a gated download). ComfyUI rescans these dirs per request — no restart after adding a file.

## Quick start

```bash
# One-time DB setup
brew install postgresql@16
brew services start postgresql@16
createdb magenta

cp .env.example .env
# Edit DATABASE_URL so the username matches your macOS login (default is `whoami`)
# (optional) pull at least one Ollama model: ollama pull llama3.1
# (optional) log into Claude: claude login

pnpm install
pnpm dev
```

`pnpm dev` runs Drizzle migrations and starts Next.js on http://localhost:3000.

## Environment variables

See `.env.example`. The minimum:

```
DATABASE_URL=postgres://magenta:magenta@localhost:5432/magenta
OLLAMA_BASE_URL=http://localhost:11434
COMFYUI_BASE_URL=http://127.0.0.1:8000   # 8188 if you run the CLI distribution
DEFAULT_LOOP_ROUNDS=3
MAGENTA_LOCAL_ONLY=true                  # 403s any non-loopback request to /api/*
```

Claude auth lives **outside** `.env` — the Claude Agent SDK reads your existing `~/.claude/` credentials, which are set up by `claude login`. There is no API key to paste.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design (project layout, provider abstraction, DB schema, SSE event shapes, abort handling).

If you are an AI assistant working in this repo, read [`CLAUDE.md`](CLAUDE.md) first — it sets the ground rules.

## License

MIT — see [`LICENSE`](LICENSE).
