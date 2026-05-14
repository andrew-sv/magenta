# Architecture

Design overview for Magenta — a local multi-agent chat. Stack: **Next.js (App Router)**, **TypeScript**, **Postgres + Drizzle**, **Vercel AI SDK** for streaming over SSE.

## Goals & non-goals

**Goals.** Run five chat modes (single, fanout, loop, council, synthesis) against a mix of hosted (Claude) and local (Ollama) models. Persist all conversations, messages, and inter-model scores. Stream every response. Make adding providers (OpenAI, Gemini, xAI) purely additive.

**Non-goals.** Multi-user auth, sharing, accounts, billing, RAG/files, agent tools/actions, cloud deployment. This is a single-machine app.

## Layout

```
app/
  layout.tsx
  page.tsx                         # mode picker + new-conversation landing
  (chat)/[conversationId]/page.tsx # renders the view matching conversation.mode
  api/
    chat/{single,fanout,loop,council,synthesis}/route.ts
    conversations/route.ts
    conversations/[id]/route.ts
    models/route.ts
lib/
  ai/        providers.ts | catalog.ts | resolve.ts
  orchestrators/  single.ts | fanout.ts | loop.ts | council.ts | synthesis.ts
  sse/       events.ts | writer.ts
  db/        client.ts | schema.ts | queries.ts | migrate.ts
  env.ts
components/  ModePicker | ModelSelect | PromptComposer | ConversationPane
             MultiPaneLayout | LoopView | CouncilView | SynthesisView | AbortButton
drizzle/                           # generated migrations
docker-compose.yml                 # postgres only
drizzle.config.ts
.env.example
middleware.ts                      # MAGENTA_LOCAL_ONLY guard on /api/*
```

Orchestrators are pure server functions — `(params, signal, db, emit) → ReadableStream`. Route handlers validate input, open a stream, and delegate. Each orchestrator owns its own SSE event schema.

## Provider abstraction

`lib/ai/providers.ts` builds one provider object per integration:

```ts
providers = {
  anthropic: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY }),
  ollama:    createOllama({ baseURL: env.OLLAMA_BASE_URL }),
}
```

`lib/ai/catalog.ts` exports a static, typed `MODEL_CATALOG`:

```ts
type ModelDescriptor = {
  id: string                  // "anthropic:claude-sonnet-4-5"
  label: string               // "Claude Sonnet 4.5"
  providerId: "anthropic" | "ollama" | "openai" | "google" | "xai"
  modelName: string
  contextWindow: number
  capabilities: { streaming: boolean; structuredOutput: boolean }
}
```

`lib/ai/resolve.ts` splits the id and returns a `LanguageModel`. **Orchestrators only see `LanguageModel`.** Adding OpenAI/Gemini/xAI later is: install the provider package, add a factory in `providers.ts`, append entries to `catalog.ts`. No call-site changes.

`/api/models` returns the catalog with each Ollama entry's availability resolved by calling `GET {OLLAMA_BASE_URL}/api/tags` at request time — unpulled models render as disabled in the UI.

Ollama uses `ollama-ai-provider-v2` (native AI SDK v5 provider). Fallback path: `@ai-sdk/openai-compatible` against `http://localhost:11434/v1`, switched via `OLLAMA_MODE=native|openai`.

## Streaming protocol

All chat routes return `text/event-stream` with:

```
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
```

We write the stream ourselves (`lib/sse/writer.ts`) rather than using AI SDK's `toDataStreamResponse` — the SDK's protocol events change between majors, and the council/loop modes need a custom event union anyway.

Each event is one SSE `data:` line containing JSON `{ type, ...payload }`. Shared events across all modes: `error`, `done`. Each route adds its own typed events:

| Route        | Events                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `single`     | `token`, `message.complete`                                                                       |
| `fanout`     | `pane.meta`, `token`, `message.complete` (one HTTP call per pane — client opens N)                |
| `loop`       | `turn.start`, `token`, `turn.complete`, `loop.complete`, `aborted`                                |
| `council`    | `member.start`, `member.token`, `member.complete`, `scoring.start`, `score`, `scoring.complete`   |
| `synthesis`  | …all council events, then `synthesis.start`, `synthesis.token`, `synthesis.complete`              |

The union lives in `lib/sse/events.ts`.

## Database schema (Drizzle, 4 tables)

```
conversations
  id uuid pk
  mode enum(single|fanout|loop|council|synthesis)
  title text
  config jsonb            -- mode-specific setup
  created_at, updated_at

messages
  id uuid pk
  conversation_id fk
  parent_id uuid null     -- siblings for fanout panes / council members
  role enum(user|assistant|system|scorer|synthesizer)
  model_id text null
  pane_key text null      -- Case 2 pane key / Case 4 member key
  round int null          -- Case 3 round number
  content text
  status enum(streaming|complete|aborted|error)
  client_message_id text null
  created_at
  UNIQUE (conversation_id, client_message_id)   -- fanout dedupe

scores
  id uuid pk
  conversation_id fk
  scorer_message_id fk messages
  target_message_id fk messages
  scorer_model_id text
  target_model_id text
  score int null          -- null when scorer produced invalid output
  rationale text null
  created_at

runs
  id uuid pk
  conversation_id fk
  mode enum
  status enum(running|complete|aborted|error)
  started_at, ended_at
  error text null
```

`conversations.config` examples:

- single:    `{}`
- fanout:    `{ paneModelIds: string[] }`
- loop:      `{ modelA: string, modelB: string, maxRounds: number }`
- council:   `{ memberIds: string[] }`
- synthesis: `{ memberIds: string[], synthesizerId: string }`

Averages for council/synthesis are computed at query time (`avg(score) GROUP BY target_message_id`).

All enums are defined up front. **Postgres enums are append-only in Drizzle migrations** — never rename or remove values; add new ones.

## Mode mechanics

### Case 1 — Single
Trivial. Persist user message, open a `streamText`, pipe tokens to SSE, persist completion.

### Case 2 — Fanout
Client renders N panes in a CSS grid (not real browser tabs). One shared `PromptComposer`. On submit, the client issues N parallel `fetch` calls to `/api/chat/fanout`, each carrying:

- `conversationId`
- `paneKey`
- a **shared** `clientMessageId`

The route upserts the user `messages` row on `(conversation_id, client_message_id)` so only one row is created across the N concurrent calls. Each pane then streams its assistant response independently. Each pane has its own abort; composer has "Stop all" that aborts every pane.

### Case 3 — A ↔ B loop
Single SSE stream, server-orchestrated. User picks A (answerer) and B (questioner). The loop:

```
A answers user prompt
for round in 1..N:
  B asks one follow-up given A's last message
  A answers
```

B's system prompt: *"Given the previous answer, ask one probing follow-up question. Output only the question."* Loop ends at `round === maxRounds` (default 3) or on abort.

Context window guard: pass at most the last K turns (default 6) into each call; older turns are dropped or summarized when approaching `0.7 * model.contextWindow`.

### Case 4 — Council with cross-scoring
Single SSE stream multiplexing N member streams. After all `member.complete` events fire, scoring runs N × (N − 1) parallel `generateObject` calls (each model scores every other member):

```
generateObject({
  model: resolveModel(scorerId),
  schema: z.object({ score: z.number().int().min(0).max(100), brief_reason: z.string().optional() }),
  prompt: "Score the following response 0–100 for correctness and usefulness..."
})
```

Up to 2 retries per scoring call. On final failure, write `score: null` and exclude from the average. Self-scoring is skipped entirely.

Averages are computed by SQL and emitted on `scoring.complete`; per-scorer breakdown is fetchable from `scores` for the hover tooltip.

### Case 5 — Synthesis
Wraps the council orchestrator. After `scoring.complete`, the synthesizer model (chosen by the user from the same catalog) receives:

- the original user prompt
- each member's response
- each member's average score

…and streams a single combined answer. Persists as a `synthesizer`-role message.

## Frontend

`app/page.tsx` is the mode picker + landing. `app/(chat)/[conversationId]/page.tsx` reads the conversation, picks a view component by `mode`, and renders. All streaming UIs use a shared Zustand store keyed by `conversationId` for in-flight buffers; finalized content is loaded from the DB via `GET /api/conversations/[id]`.

- **MultiPaneLayout** — CSS grid `repeat(n, 1fr)` with horizontal scroll past 3 panes. Each pane owns its own fetch-stream reader.
- **LoopView** — vertical timeline; A left-aligned, B right-aligned with a "questioner" badge; round counter + abort button.
- **CouncilView** — responsive grid (2 × 2 for 4 members). Score badge animates in on `scoring.complete`; hover reveals per-scorer breakdown. Failed scorers render `—`.
- **SynthesisView** — CouncilView on top, sticky synth panel at the bottom.

## Abort / cancellation

Every chat route handler creates an `AbortController` and ties `request.signal` to it. The signal is threaded into every `streamText` / `generateObject` call. A `try/finally` on the orchestrator updates the matching `runs` row's `status`.

- **Loop**: one shared signal; the `for (round)` loop checks `signal.aborted` between turns.
- **Council/Synthesis**: parent signal feeds all members; user abort cancels every sibling. Scoring runs only if `!signal.aborted` after members resolve.
- **Fanout**: each pane owns its abort independently; composer's "Stop all" hits every pane.

## Local-only guard

`middleware.ts` checks `request.ip` against loopback (`127.0.0.1`, `::1`) when `MAGENTA_LOCAL_ONLY=true` (default). Any other origin gets a 403 on `/api/*`. This protects against accidental LAN/ngrok exposure.

## Open risks

1. **Ollama serializes generations per loaded model.** A 3-Ollama council is sequential. Mix providers or accept it.
2. **Local-model JSON unreliability.** `generateObject` + retries + `null` fallback. Don't gate the UI on perfect scoring output.
3. **Case 3 context blow-up.** Cap at last K turns; summarize older if you hit `0.7 * contextWindow`.
4. **AI SDK churn.** Pin exact versions. Own the SSE event schema.
5. **Branching message model.** Cleaner schema, mode-aware rendering on the view layer.
