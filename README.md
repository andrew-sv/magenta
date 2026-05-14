# Magenta

Local multi-agent chat. Talk to one model, several models in parallel, two models in a question/answer loop, or a council of models that score each other and (optionally) synthesize a combined answer.

Runs entirely on your machine. Models are reached through:

- **Anthropic Claude** via API key
- **Ollama** for local models

Designed so adding **OpenAI**, **Gemini**, and **xAI** later is a drop-in change.

## Modes

| Mode          | What it does                                                                                |
| ------------- | ------------------------------------------------------------------------------------------- |
| **Single**    | Pick one model, normal chat.                                                                |
| **Fanout**    | Two or more panes side-by-side, each pinned to a different model. One prompt → all panes.   |
| **Loop**      | Pick Model A (answerer) and Model B (questioner). You write one prompt; the pair takes N rounds (default 3). |
| **Council**   | 3–4 models answer the same prompt in parallel. Each model scores the others 0–100. Averages shown per response. |
| **Synthesis** | Council + a final synthesizer model that combines all responses into one answer.            |

## Requirements

- **Node 20+**
- **pnpm** (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Docker** (for Postgres)
- **Ollama** running natively if you want local models (`brew install ollama` on macOS, then `ollama serve`)
- **Anthropic API key** if you want Claude models

## Quick start

```bash
cp .env.example .env
# fill ANTHROPIC_API_KEY, pull at least one Ollama model: ollama pull llama3.1
pnpm install
pnpm dev
```

`pnpm dev` brings up the Postgres container, runs migrations, and starts Next.js on http://localhost:3000.

## Environment variables

See `.env.example`. The minimum:

```
DATABASE_URL=postgres://magenta:magenta@localhost:5432/magenta
ANTHROPIC_API_KEY=          # optional but needed for Claude
OLLAMA_BASE_URL=http://localhost:11434
DEFAULT_LOOP_ROUNDS=3
MAGENTA_LOCAL_ONLY=true     # 403s any non-loopback request to /api/*
```

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design (project layout, provider abstraction, DB schema, SSE event shapes, abort handling).

If you are an AI assistant working in this repo, read [`CLAUDE.md`](CLAUDE.md) first — it sets the ground rules.

## License

MIT — see [`LICENSE`](LICENSE).
