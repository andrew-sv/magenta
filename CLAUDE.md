# CLAUDE.md

Working notes for Claude (or any coding agent) on this repo.

## What this is

Local multi-agent chat. Next.js (App Router) + TypeScript + Postgres + Drizzle. Vercel AI SDK for streaming. Five modes: single, fanout, loop, council, synthesis. See `README.md` and `ARCHITECTURE.md` first.

## Ground rules

- **No tests scaffolded yet.** Don't add a test framework or write tests unless explicitly asked.
- **No new docs files** beyond `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`. Don't drop `NOTES.md` / planning markdown unless the user asks.
- **Defaults are intentional.** No API keys for Claude — auth lives in `~/.claude/` and is set up by `claude login`. Ollama is keyless by design. No UI for keys. No auth on the app itself. Single local user.
- **Provider abstraction is sacred.** Orchestrators only see the internal `ChatProvider` interface in `lib/ai/types.ts`. Don't import `@anthropic-ai/claude-agent-sdk`, `ai`, or `ollama-ai-provider-v2` inside orchestrators, routes, or components. Adding a provider = new adapter in `lib/ai/providers/`, route it in `lib/ai/resolve.ts`, append entries to `lib/ai/catalog.ts`. Nothing else.
- **One route per mode.** Don't unify the chat endpoints behind a `mode` discriminator — each route owns its own SSE event schema.
- **Own the SSE schema.** Use the custom writer in `lib/sse/`. Do not return `streamText().toDataStreamResponse()` from route handlers; the Vercel AI SDK's protocol events change between majors. Same rule for the Claude Agent SDK — translate its messages into our typed events before emitting.
- **Drizzle enums are append-only on Postgres.** Add new values; don't rename or remove. If you must change semantics, write a new enum and migrate.
- **Abort signals propagate.** Every orchestrator must take a signal and pass it into every `streamText` / `generateObject` call. Don't swallow `AbortError`.
- **Branching message model.** `messages.parent_id` makes fanout panes and council members siblings of the user prompt. View layer is mode-aware. Don't flatten this.

## Things that will bite you

- **Ollama serializes per loaded model.** A 3-Ollama council is sequential under the hood. Don't market it as parallel in the UI text.
- **Local-model JSON is unreliable for scoring.** Always go through `provider.generateObject` + zod with retries; on failure record `score: null` and surface `—`. Never crash the council on a malformed scorer.
- **Claude is subscription-quota gated.** Each Claude call hits the user's Pro/Max quota. Council/synthesis can burn through it fast. Surface `SDKAssistantMessage.error === 'rate_limit'` and `'authentication_failed'` as first-class UI states; don't swallow them.
- **Claude Agent SDK is not API-key-based.** Don't add `ANTHROPIC_API_KEY`. The SDK reads `~/.claude/` credentials produced by `claude login`. If the user reports auth errors, the fix is `claude login`, not an env var.
- **Disable Agent SDK tools.** Always pass `tools: []` and `permissionMode: 'bypassPermissions'` for our calls — we're using it as a thin LLM client, not as an agent. Letting it default to the `claude_code` preset would give the model filesystem/shell access we don't want.
- **Case 3 context grows fast.** Cap at last K turns (default 6) or summarize. Don't pass the full transcript into every step.
- **Next.js dev server can buffer SSE.** Headers `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` are not optional — they're in the SSE writer; keep them there.
- **`MAGENTA_LOCAL_ONLY` middleware** must guard `/api/*`. Don't disable it casually.

## Style

- Pin `ai` and provider packages to **exact** versions in `package.json`.
- Comments only where the *why* is non-obvious. Don't narrate what the code does.
- Server components by default; `"use client"` only where interactivity demands it (composer, streaming panes, abort buttons).
- Tailwind for styling. No CSS modules unless a component genuinely needs scoped styles.

## When you're stuck

Re-read `ARCHITECTURE.md`. If the answer isn't there and the user is around, ask. Don't invent a new mode, table, or event type without confirming.
