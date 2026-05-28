# Architecture

Design overview for Magenta — a local multi-agent chat. Stack: **Next.js (App Router)**, **TypeScript**, **Postgres + Drizzle**. Text streaming uses **Vercel AI SDK** (for Ollama and future OpenAI/Gemini/xAI) and the **Claude Agent SDK** (for Claude, billed against the user's Pro/Max subscription) behind a single internal abstraction. Image, animation, and music generation use a local **ComfyUI** server (`http://127.0.0.1:8000` for the Desktop app) over its REST + WebSocket API.

## Goals & non-goals

**Goals.** Run eight modes (single, fanout, loop, council, synthesis, imagine, animate, music) against a mix of hosted (Claude) and local (Ollama text/vision, ComfyUI image/animation/audio) models. Persist all conversations, messages, attachments, and inter-model scores. Stream every response. Make adding providers (OpenAI, Gemini, xAI) purely additive.

**Non-goals.** Multi-user auth, sharing, accounts, billing, RAG/files, agent tools/actions, cloud deployment. This is a single-machine app.

## Layout

```
app/
  layout.tsx
  page.tsx                         # mode picker + links to history pages
  chat/[conversationId]/page.tsx   # renders the view matching conversation.mode
  chats/history/page.tsx           # text-mode conversation list, grouped by mode
  imagine/history/page.tsx         # gallery view of past imagine sessions
  animate/history/page.tsx         # gallery view of past animate sessions
  music/history/page.tsx           # player grid of past music sessions
  api/
    chat/{single,fanout,loop,council,synthesis,imagine,animate,music}/route.ts
    conversations/route.ts
    conversations/[id]/route.ts
    models/route.ts
lib/
  ai/        types.ts | catalog.ts | resolve.ts | workflows.ts
  ai/providers/  anthropic-agent.ts | vercel-ollama.ts | google.ts | comfyui.ts
  orchestrators/  single.ts | fanout.ts | loop.ts | council.ts | synthesis.ts | imagine.ts | animate.ts | music.ts
  sse/       events.ts | writer.ts | client.ts
  db/        client.ts | schema.ts | queries.ts | migrate.ts
  env.ts
components/  ModePicker | ModelSelect | PromptComposer | Markdown
             SingleChatView | FanoutView | LoopView | CouncilView | SynthesisView | ImagineView | AnimateView | MusicView
drizzle/                           # generated migrations
drizzle.config.ts
.env.example
middleware.ts                      # MAGENTA_LOCAL_ONLY guard on /api/*
public/generated/                  # ComfyUI image/GIF/audio output, gitignored, served by Next's static handler
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

Animation and music reuse the same event-stream shape with their own params and terminal event. **`AnimationProvider`** takes AnimateDiff knobs (`frames`, `fps`, `motionModule`, `motionScale`) and ends with a `gif` event. **`AudioProvider`** takes music knobs and ends with an `audio` event:

```ts
// lib/ai/types.ts
export type AudioEvent =
  | { type: "queued"; position: number }
  | { type: "progress"; current: number; total: number }
  | { type: "audio"; mime: string; dataBase64: string; durationSeconds?: number; seed?: number }

export interface AudioProvider {
  generate(params: {
    modelName: string         // checkpoint filename
    workflow: string          // "ace-step" | "stable-audio"
    prompt: string            // style/genre/mood ("tags" for ACE-Step)
    lyrics?: string           // sung by ACE-Step; ignored by instrumental models
    negativePrompt?: string
    durationSeconds: number; steps: number; cfg?: number; seed?: number
    signal: AbortSignal
  }): AsyncIterable<AudioEvent>
}
```

All three ComfyUI-backed interfaces are implemented by adapters in `comfyui.ts` sharing the same WebSocket/queue/`/history`/`/view` machinery — only the workflow graph and terminal output type differ. `AudioEvent` has no `preview` (audio workflows emit no usable preview frames).

`lib/ai/providers/` holds these adapters:

- **`anthropic-agent.ts`** — wraps `query()` from `@anthropic-ai/claude-agent-sdk` with `tools: []`, `includePartialMessages: true`, and an `abortController`. Token deltas come from `SDKPartialAssistantMessage` events. `generateObject` is implemented by prompting for JSON-only output and validating with zod (with up to 2 retries).
- **`vercel-ollama.ts`** — wraps `streamText` / `generateObject` from the Vercel AI SDK. Currently used for Ollama via `ollama-ai-provider-v2`; future hosted providers (OpenAI, xAI) plug in here.
- **`google.ts`** — Gemini text/vision via the Vercel AI SDK's Google provider, gated on `GOOGLE_GENERATIVE_AI_API_KEY`.
- **`comfyui.ts`** — wraps ComfyUI's REST + WebSocket protocol. Opens a `/ws?clientId=…` connection, POSTs a workflow JSON to `/prompt`, demultiplexes `progress`, `executing`, `execution_error`/`execution_interrupted`, and binary preview frames, and fetches finished files from `/view`. Exports three adapters off this same plumbing: `comfyUIProvider` (`ImageProvider`, images from `outputs.*.images`), `comfyUIAnimationProvider` (`AnimationProvider`, GIF from `outputs.*.gifs`), and `comfyUIAudioProvider` (`AudioProvider`, file from `outputs.*.audio`). Abort calls `/interrupt` (note: it is global, not per-prompt).

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

type AnimationModelDescriptor = {
  id: string; label: string; providerId: "comfyui"; modelName: string
  kind: "animation"
  workflow: string                 // "animatediff-sd15"
  motionModule: string             // file in ComfyUI/models/animatediff_models/
  defaults: { width; height; steps; cfg?; frames; fps }
}

type AudioModelDescriptor = {
  id: string                       // "comfyui:ace-step-v1"
  label: string; providerId: "comfyui"; modelName: string
  kind: "audio"
  workflow: string                 // "ace-step" | "stable-audio"
  supportsLyrics: boolean          // ACE-Step true; Stable Audio false
  defaults: { durationSeconds: number; steps: number; cfg?: number }
}

type ModelDescriptor =
  | TextModelDescriptor | ImageModelDescriptor | AnimationModelDescriptor | AudioModelDescriptor
```

`lib/ai/resolve.ts` exports four narrowing resolvers, one per `kind`: **`resolveModel(id)`** (`ChatProvider`), **`resolveImageModel(id)`** (`ImageProvider`), **`resolveAnimationModel(id)`** (`AnimationProvider`), and **`resolveAudioModel(id)`** (`AudioProvider`). Each throws if the id's `kind` doesn't match. Adding a provider later: append entries in `catalog.ts` with the right `kind` and route the providerId in the matching resolver.

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
| `animate`    | `animate.tile.meta`, `animate.queued`, `animate.progress`, `animate.gif` (one HTTP call per tile)  |
| `music`      | `music.tile.meta`, `music.queued`, `music.progress`, `music.audio` (one HTTP call per tile)        |

The union lives in `lib/sse/events.ts`.

## Database schema (Drizzle, 4 tables)

```
conversations
  id uuid pk
  mode enum(single|fanout|loop|council|synthesis|imagine|animate|music)
  title text
  config jsonb            -- mode-specific setup
  created_at, updated_at

messages
  id uuid pk
  conversation_id fk
  parent_id uuid null     -- siblings for fanout panes / council members / imagine|animate|music tiles
  role enum(user|assistant|system|scorer|synthesizer)
  model_id text null
  pane_key text null      -- Case 2 pane key / Case 4 member key / Case 6-8 tile key
  round int null          -- Case 3 round number
  content text            -- prompt for media (imagine/animate/music) assistant messages
  status enum(streaming|complete|aborted|error)
  client_message_id text null
  attachments jsonb       -- MessageAttachment[]: media refs for imagine/animate/music (see below)
  created_at
  UNIQUE (conversation_id, client_message_id)   -- fanout / imagine / animate / music dedupe

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
- animate:   `{}` (tiles are fixed low/high-motion presets, client-side)
- music:     `{}` (tiles are fixed ACE-Step / Stable Audio, client-side)

`messages.attachments` is typed as `MessageAttachment[]` — a union of image and audio refs (see `lib/db/schema.ts`):

```ts
type ImageAttachment = {           // imagine (.png) and animate (.gif)
  kind: "image"
  path: string                     // "/generated/<conversationId>/<messageId>.png"
  mime: string
  width?: number; height?: number
  modelId?: string; prompt?: string
}

type AudioAttachment = {           // music (.flac/.mp3/…)
  kind: "audio"
  path: string                     // "/generated/<conversationId>/<messageId>.flac"
  mime: string
  durationSeconds?: number
  modelId?: string; prompt?: string
}

type MessageAttachment = ImageAttachment | AudioAttachment
```

Defaults to `[]` for every row; only imagine/animate/music assistant messages populate it.

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

### Case 7 — Animate
Same client/server shape as Imagine, resolved via `resolveAnimationModel(modelId)` (catalog `kind: "animation"`). Tiles are fixed **motion presets** (low ×0.6 / high ×1.2) rather than distinct models — both submit the same `comfyui:animatediff-sd15` model with a different `motionScale`. The adapter runs the `animatediff-sd15` workflow (SD1.5 + AnimateDiff-Evolved), and `ADE_AnimateDiffCombine` emits the GIF directly; the orchestrator writes it to `public/generated/<conversationId>/<messageId>.gif` and emits `animate.gif`. No `preview` events (AnimateDiff has no usable preview frames).

### Case 8 — Music
Same client/server shape again, resolved via `resolveAudioModel(modelId)` (catalog `kind: "audio"`). Two tiles, each pinned to a different model: **ACE-Step** (`song`, full track with optional sung lyrics) and **Stable Audio Open** (`instrumental`). The composer adds a style prompt, an optional lyrics field, and a length (seconds); lyrics are sent only to tiles whose descriptor has `supportsLyrics`. Each call:

1. Inserts an assistant `messages` row in `streaming` status keyed by `pane_key = tileKey`, `parent_id = userMessage.id`.
2. Streams `AudioEvent`s, translating `queued`/`progress` to `music.queued`/`music.progress`.
3. On `audio`, writes the file (extension derived from MIME) to `public/generated/<conversationId>/<messageId>.<ext>` and emits `music.audio` with the URL path.
4. Updates the assistant row with `content = prompt`, `attachments = [{kind: "audio", path, mime, durationSeconds, …}]`, `status = complete`.

Workflows: `ace-step` is an all-in-one checkpoint (`CheckpointLoaderSimple` → model+clip+vae, `TextEncodeAceStepAudio` carries `tags`+`lyrics`, `EmptyAceStepLatentAudio`, `VAEDecodeAudio`, `SaveAudio`). `stable-audio` loads its text encoder separately — the checkpoint does **not** bundle T5, so a `CLIPLoader` reads `t5_base.safetensors` (`type: "stable_audio"`) for the `CLIPTextEncode` pair while MODEL/VAE come from the checkpoint.

## Frontend

`app/page.tsx` is the mode picker + landing, with links to `/chats/history`, `/imagine/history`, `/animate/history`, and `/music/history`. `app/chat/[conversationId]/page.tsx` reads the conversation, picks a view component by `mode`, and renders. All streaming UIs are client components that consume SSE via `lib/sse/client.ts`; finalized content is loaded from the DB via `GET /api/conversations/[id]` on mount and reconstructed into the view's local state.

- **SingleChatView** — vertical message list, one model picker.
- **FanoutView** — N panes in a horizontal scroll; each pane owns its own SSE reader and abort controller.
- **LoopView** — vertical timeline; A left-aligned, B right-aligned with a "questioner" badge; round counter + abort button.
- **CouncilView** — responsive grid (2 × 2 for 4 members). Score badge animates in on `scoring.complete`; hover reveals per-scorer breakdown. Failed scorers render `—`.
- **SynthesisView** — CouncilView on top, sticky synth panel at the bottom.
- **ImagineView** — N tiles, each pinned to an image checkpoint; per-tile rounds show prompt → progress bar → live preview thumbnail → final image. ModelSelect is filtered by `filterKind="image"`.
- **AnimateView** — two fixed motion-preset tiles; per-tile rounds show prompt → progress bar → final GIF.
- **MusicView** — two fixed model tiles (ACE-Step song / Stable Audio instrumental); a composer with style prompt, optional lyrics, and length; per-tile rounds show prompt → progress bar → `<audio controls>` player.

History pages:

- **`/chats/history`** — server component listing all non-media conversations (excludes imagine/animate/music), grouped by mode, newest first. Each row shows title (or first user prompt), last assistant snippet, message count, last-updated.
- **`/imagine/history`**, **`/animate/history`**, **`/music/history`** — server components listing media sessions grouped by conversation (thumbnail grid for imagine/animate, player grid for music). Backed by `listImagineGallery` / `listAnimateGallery` / `listMusicGallery`, which share one `listGalleryByMode` helper joining `conversations`/`messages` and filtering on `jsonb_array_length(attachments) > 0`.

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
7. **ComfyUI queue is serial and `/interrupt` is global.** Fanned-out imagine/animate/music tiles run one at a time; aborting one tile can cancel another that happens to be the currently-running prompt. Mitigation (not implemented yet): cross-check `/queue` before issuing `/interrupt`.
8. **Checkpoint load is silent.** ComfyUI emits no WebSocket events while a large checkpoint loads from disk to MPS — only after `KSampler` starts. First-time generation (FLUX image, ACE-Step audio) can look like a hang. Surface "loading…" via `executing { node: <loader id> }` events if it becomes a UX issue.
9. **Media storage in `public/`.** Generated PNGs/GIFs/audio live under `public/generated/<conversationId>/` so Next can serve them statically; they're outside the DB and the directory is gitignored. Deleting an imagine/animate/music conversation removes its directory (path-guarded `rm` in `DELETE /api/conversations/[id]`), but a crash mid-run can still orphan files.
10. **Audio model weights are large and partly gated.** ACE-Step (`ace_step_v1_3.5b.safetensors`, ~7 GB) is a clean download; Stable Audio Open is license-gated on Hugging Face and needs a separate `t5_base.safetensors` in `models/text_encoders/`. Missing weights surface as a ComfyUI `/prompt` 400 (`value_not_in_list` on `ckpt_name`) on first generation, not at startup — the catalog lists them unconditionally.
