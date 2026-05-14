# Magenta

Local multi-agent chat. Talk to one model, several models in parallel, two models in a question/answer loop, or a council of models that score each other and (optionally) synthesize a combined answer.

Runs entirely on your machine. Models are reached through:

- **Anthropic Claude** via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), authenticated against your **Claude Pro / Max subscription** (no API key needed — calls bill against your subscription quota)
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
- **Postgres 16** running locally (`brew install postgresql@16 && brew services start postgresql@16` on macOS)
- **Ollama** running natively if you want local models (`brew install ollama` on macOS, then `ollama serve`)
- **Claude Code CLI** installed and logged into your Pro/Max subscription (`claude login`) if you want Claude models

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
DEFAULT_LOOP_ROUNDS=3
MAGENTA_LOCAL_ONLY=true     # 403s any non-loopback request to /api/*
```

Claude auth lives **outside** `.env` — the Claude Agent SDK reads your existing `~/.claude/` credentials, which are set up by `claude login`. There is no API key to paste.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design (project layout, provider abstraction, DB schema, SSE event shapes, abort handling).

If you are an AI assistant working in this repo, read [`CLAUDE.md`](CLAUDE.md) first — it sets the ground rules.

## License

MIT — see [`LICENSE`](LICENSE).
