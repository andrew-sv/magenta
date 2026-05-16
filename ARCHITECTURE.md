# Architecture

Design overview for Magenta — a local multi-agent chat. Stack: **Next.js (App Router)**, **TypeScript**, **Postgres + Drizzle**. Text streaming uses **Vercel AI SDK** (for Ollama and future OpenAI/Gemini/xAI) and the **Claude Agent SDK** (for Claude, billed against the user's Pro/Max subscription) behind a single internal abstraction. Image generation uses a local **ComfyUI** server (`http://127.0.0.1:8000` for the Desktop app) over its REST + WebSocket API.

## Goals & non-goals

**Goals.** Run six modes (single, fanout, loop, council, synthesis, imagine) against a mix of hosted (Claude) and local (Ollama text/vision, ComfyUI image) models. Persist all conversations, messages, attachments, and inter-model scores. Stream every response. Make adding providers (OpenAI, Gemini, xAI) purely additive.

**Non-goals.** Multi-user auth, sharing, accounts, billing, RAG/files, agent tools/actions, cloud deployment. This is a single-machine app.

## Layout

```
app/
  layout.tsx
  page.tsx                         # mode picker + links to history pages
  chat/[conversationId]/page.tsx   # renders the view matching conversation.mode
  chats/history/page.tsx           # text-mode conversation list, grouped by mode
  imagine/history/page.tsx         # gallery view of past imagine sessions
  api/
    chat/{single,fanout,loop,council,synthesis,imagine}/route.ts
    conversations/route.ts
    conversations/[id]/route.ts
    models/route.ts
lib/
  ai/        types.ts | catalog.ts | resolve.ts | workflows.ts
  ai/providers/  anthropic-agent.ts | vercel-ollama.ts | comfyui.ts
  orchestrators/  single.ts | fanout.ts | loop.ts | council.ts | synthesis.ts | imagine.ts
  sse/       events.ts | writer.ts | client.ts
  db/        client.ts | schema.ts | queries.ts | migrate.ts
  env.ts
components/  ModePicker | ModelSelect | PromptComposer | Markdown
             SingleChatView | FanoutView | LoopView | CouncilView | SynthesisView | ImagineView
drizzle/                           # generated migrations
drizzle.config.ts
.env.example
middleware.ts                      # MAGENTA_LOCAL_ONLY guard on /api/*
public/generated/                  # ComfyUI output, gitignored, served by Next's static handler
```

Orchestrators are pure server functions — `(params, signal, db, emit) → ReadableStream`. Route handlers validate input, open a stream, and delegate. Each orchestrator owns its own SSE event schema.

## Provider abstraction

We can't use the Vercel AI SDK uniformly because Claude is reached through the **Claude Agent SDK** (subscription-billed via `claude login`), which has a different surface than `LanguageModel`. So orchestrators talk to a small in-house interface, and each backing SDK has its own adapter.

```ts
// lib/ai/types.ts
export type ChatMessage = { role: "user" | "assistant" | "system"; content: string }

export interface ChatProvider {
  stream(params: {
    modelName: string
    messages: ChatMessage[]
    system?: string
    signal: AbortSignal
  }): AsyncIterable<{ type: "text-delta"; delta: string }>

  generateObject<T>(params: {
    modelName: string
    messages: ChatMessage[]
    system?: string
    schema: z.ZodType<T>
    signal: AbortSignal
  }): Promise<T | null>     // null on irrecoverable parse/validation failure
}
```

Image generation needs a different shape — there's no token stream, only progress + preview + final-image events — so it has a sibling interface:

```ts
// lib/ai/types.ts
export type ImageEvent =
  | { type: "queued"; position: number }
  | { type: "progress"; current: number; total: number }
  | { type: "preview"; mime: string; dataBase64: string }
  | { type: "image"; mime: string; dataBase64: string; width?: number; height?: number; seed?: number }

export interface ImageProvider {
  generate(params: {
    modelName: string         // checkpoint filename
    workflow: string          // workflow template name in lib/ai/workflows.ts
    prompt: string
    negativePrompt?: string
    width: number; height: number; steps: number; cfg?: number; seed?: number
    signal: AbortSignal
  }): AsyncIterable<ImageEvent>
}
```

`lib/ai/providers/` holds three adapters:

- **`anthropic-agent.ts`** — wraps `query()` from `@anthropic-ai/claude-agent-sdk` with `tools: []`, `includePartialMessages: true`, and an `abortController`. Token deltas come from `SDKPartialAssistantMessage` events. `generateObject` is implemented by prompting for JSON-only output and validating with zod (with up to 2 retries).
- **`vercel-ollama.ts`** — wraps `streamText` / `generateObject` from the Vercel AI SDK. Currently used for Ollama via `ollama-ai-provider-v2`; future hosted providers (OpenAI, Gemini, xAI) plug in here.
- **`comfyui.ts`** — wraps ComfyUI's REST + WebSocket protocol. Opens a `/ws?clientId=…` connection, POSTs a workflow JSON to `/prompt`, demultiplexes `progress`, `executing`, `execution_success`, and binary preview frames into typed `ImageEvent`s, and fetches finished images from `/view`. Abort calls `/interrupt` (note: it is global, not per-prompt).

`lib/ai/catalog.ts` exports a discriminated `MODEL_CATALOG`:

```ts
type TextModelDescriptor = {
  id: string                       // "anthropic:claude-opus-4-7"
  label: string
  providerId: "anthropic" | "ollama" | "openai" | "google" | "xai"
  modelName: string
  kind: "text"
  contextWindow: number
  capabilities: { streaming: boolean; structuredOutput: boolean }
}

type ImageModelDescriptor = {
  id: string                       // "comfyui:flux-schnell"
  label: string
  providerId: "comfyui"
  modelName: string                // checkpoint filename, e.g. "flux1-schnell-fp8.safetensors"
  kind: "image"
  workflow: string                 // "sdxl-turbo" | "flux-schnell" | …
  defaults: { width: number; height: number; steps: number; cfg?: number }
}

type ModelDescriptor = TextModelDescriptor | ImageModelDescriptor
```

`lib/ai/resolve.ts` exports two narrowing resolvers: **`resolveModel(id)`** returns `{ descriptor: TextModelDescriptor; provider: ChatProvider }` and throws for image ids; **`resolveImageModel(id)`** is the symmetric image-side resolver. Adding a hosted provider later: append entries in `catalog.ts` with the right `kind` and route the providerId in the matching resolver.

`/api/models` returns the catalog with each entry's availability resolved at request time:

- Ollama → `GET {OLLAMA_BASE_URL}/api/tags`
- ComfyUI → `GET {COMFYUI_BASE_URL}/object_info/CheckpointLoaderSimple` (reads the checkpoint dropdown values)
- Anthropic → marked available (we can't cheaply probe Claude auth without making a billed call; auth errors surface on first use)

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
| `imagine`    | `tile.meta`, `imagine.queued`, `imagine.progress`, `imagine.preview`, `imagine.image` (one HTTP call per tile — client opens N) |

The union lives in `lib/sse/events.ts`.

## Database schema (Drizzle, 4 tables)

```
conversations
  id uuid pk
  mode enum(single|fanout|loop|council|synthesis|imagine)
  title text
  config jsonb            -- mode-specific setup
  created_at, updated_at

messages
  id uuid pk
  conversation_id fk
  parent_id uuid null     -- siblings for fanout panes / council members / imagine tiles
  role enum(user|assistant|system|scorer|synthesizer)
  model_id text null
  pane_key text null      -- Case 2 pane key / Case 4 member key / Case 6 tile key
  round int null          -- Case 3 round number
  content text            -- prompt for imagine assistant messages
  status enum(streaming|complete|aborted|error)
  client_message_id text null
  attachments jsonb       -- MessageAttachment[]: image refs for imagine mode (see below)
  created_at
  UNIQUE (conversation_id, client_message_id)   -- fanout / imagine dedupe

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
- imagine:   `{ tileModelIds: string[] }`

`messages.attachments` is typed as `MessageAttachment[]` (see `lib/db/schema.ts`):

```ts
type MessageAttachment = {
  kind: "image"
  path: string              // "/generated/<conversationId>/<messageId>.png"
  mime: string
  width?: number
  height?: number
  modelId?: string
  prompt?: string
}
```

Defaults to `[]` for every row; only imagine assistant messages populate it.

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
Single SSE stream multiplexing N member streams. After all `member.complete` events fire, scoring runs N × (N − 1) parallel `provider.generateObject` calls (each model scores every other member). The shared schema:

```ts
z.object({
  score: z.number().int().min(0).max(100),
  brief_reason: z.string().optional(),
})
```

The Vercel adapter routes this to AI SDK's native `generateObject`; the Claude Agent adapter prompts for JSON-only output and validates locally. Both retry up to 2 times. On final failure, the row in `scores` records `score: null` and the value is excluded from the average. Self-scoring is skipped entirely.

Averages are computed by SQL and emitted on `scoring.complete`; per-scorer breakdown is fetchable from `scores` for the hover tooltip.

### Case 5 — Synthesis
Wraps the council orchestrator. After `scoring.complete`, the synthesizer model (chosen by the user from the same catalog) receives:

- the original user prompt
- each member's response
- each member's average score

…and streams a single combined answer. Persists as a `synthesizer`-role message.

### Case 6 — Imagine
Same client/server shape as Fanout — one HTTP call per tile, shared `clientMessageId` so the user-side `messages` row is upserted exactly once. Each call:

1. Resolves the image model via `resolveImageModel(modelId)` (catalog `kind: "image"` + ComfyUI adapter).
2. Inserts an assistant `messages` row in `streaming` status keyed by `paneKey = tileKey`, with `parent_id = userMessage.id`.
3. Streams `ImageEvent`s from the adapter, translating to SSE events:
   - `queued` → `imagine.queued`
   - `progress` → `imagine.progress`
   - `preview` → `imagine.preview` (live thumbnail, base64)
   - `image` → write the PNG to `public/generated/<conversationId>/<messageId>.png` and emit `imagine.image` with the URL path
4. Updates the assistant row with `content = prompt`, `attachments = [{kind: "image", path, mime, …}]`, `status = complete`.

Workflow templates (`lib/ai/workflows.ts`) are TypeScript functions `(params) => ComfyWorkflow` that build the node-graph JSON ComfyUI's `/prompt` endpoint expects. Currently shipped: `sdxl-turbo`, `flux-schnell`. Adding a workflow = a new builder + a catalog entry referencing it; orchestrator code is untouched.

ComfyUI's `/interrupt` endpoint is **global** — it cancels whatever's running in the queue regardless of `prompt_id`. We accept that limitation; the alternative (cross-check `/queue` before interrupting) is on the table if it bites in practice.

## Frontend

`app/page.tsx` is the mode picker + landing, with links to `/chats/history` and `/imagine/history`. `app/chat/[conversationId]/page.tsx` reads the conversation, picks a view component by `mode`, and renders. All streaming UIs are client components that consume SSE via `lib/sse/client.ts`; finalized content is loaded from the DB via `GET /api/conversations/[id]` on mount and reconstructed into the view's local state.

- **SingleChatView** — vertical message list, one model picker.
- **FanoutView** — N panes in a horizontal scroll; each pane owns its own SSE reader and abort controller.
- **LoopView** — vertical timeline; A left-aligned, B right-aligned with a "questioner" badge; round counter + abort button.
- **CouncilView** — responsive grid (2 × 2 for 4 members). Score badge animates in on `scoring.complete`; hover reveals per-scorer breakdown. Failed scorers render `—`.
- **SynthesisView** — CouncilView on top, sticky synth panel at the bottom.
- **ImagineView** — N tiles, each pinned to an image checkpoint; per-tile rounds show prompt → progress bar → live preview thumbnail → final image. ModelSelect is filtered by `filterKind="image"`.

History pages:

- **`/chats/history`** — server component listing all non-imagine conversations, grouped by mode, newest first. Each row shows title (or first user prompt), last assistant snippet, message count, last-updated.
- **`/imagine/history`** — server component listing imagine sessions, grouped by conversation, with a thumbnail grid per session. Backed by `listImagineGallery` which joins `conversations`/`messages` and filters on `jsonb_array_length(attachments) > 0`.

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
4. **AI SDK + Claude Agent SDK churn.** Pin exact versions for `ai`, `@anthropic-ai/claude-agent-sdk`, and `ollama-ai-provider-v2`. Own the SSE event schema rather than relying on either SDK's protocol events.
5. **Claude subscription quota.** All Claude calls consume the user's Pro/Max quota; council/synthesis mode multiplies usage by `N * (N − 1) + N` calls per turn. The UI should surface quota-exhaustion errors clearly (the Agent SDK reports them as `error: 'rate_limit'` on `SDKAssistantMessage`).
6. **Branching message model.** Cleaner schema, mode-aware rendering on the view layer.
7. **ComfyUI queue is serial and `/interrupt` is global.** Fanned-out imagine prompts run one at a time; aborting one tile can cancel another that happens to be the currently-running prompt. Mitigation (not implemented yet): cross-check `/queue` before issuing `/interrupt`.
8. **Checkpoint load is silent.** ComfyUI emits no WebSocket events while a 16 GB FLUX checkpoint loads from disk to MPS — only after `KSampler` starts. First-time generation can look like a hang. Surface "loading…" via `executing { node: <CheckpointLoaderSimple id> }` events if it becomes a UX issue.
9. **Image storage in `public/`.** Generated PNGs live under `public/generated/` so Next can serve them statically, but they're outside the DB and the directory is gitignored. Deleting a conversation does not yet delete its files; orphaned images accumulate until manual cleanup.
