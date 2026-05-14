/**
 * Discriminated union of every SSE event the chat routes emit.
 *
 * Keep the schema additive — never rename event types or remove fields.
 * Clients ignore unknown event types so adding new ones is safe.
 */

export type ErrorEvent = { type: "error"; message: string };
export type DoneEvent = { type: "done" };

// Case 1 — Single
export type SingleTokenEvent = { type: "token"; delta: string };
export type SingleMessageCompleteEvent = { type: "message.complete"; messageId: string };

export type SingleEvent =
  | SingleTokenEvent
  | SingleMessageCompleteEvent
  | ErrorEvent
  | DoneEvent;

// Case 2 — Fanout (per-call stream; one pane per HTTP call)
export type PaneMetaEvent = {
  type: "pane.meta";
  paneKey: string;
  modelId: string;
  userMessageId: string;
  assistantMessageId: string;
};

export type FanoutEvent =
  | PaneMetaEvent
  | SingleTokenEvent
  | SingleMessageCompleteEvent
  | ErrorEvent
  | DoneEvent;

// Case 3 — Loop
export type LoopTurnStartEvent = {
  type: "turn.start";
  turnId: string;
  role: "A" | "B";
  round: number;
  modelId: string;
};
export type LoopTokenEvent = { type: "token"; turnId: string; delta: string };
export type LoopTurnCompleteEvent = { type: "turn.complete"; turnId: string };
export type LoopCompleteEvent = { type: "loop.complete"; rounds: number };
export type LoopAbortedEvent = { type: "aborted" };

export type LoopEvent =
  | LoopTurnStartEvent
  | LoopTokenEvent
  | LoopTurnCompleteEvent
  | LoopCompleteEvent
  | LoopAbortedEvent
  | ErrorEvent
  | DoneEvent;

// Case 4 — Council
export type CouncilMemberStartEvent = {
  type: "member.start";
  memberKey: string;
  modelId: string;
  messageId: string;
};
export type CouncilMemberTokenEvent = {
  type: "member.token";
  memberKey: string;
  delta: string;
};
export type CouncilMemberCompleteEvent = {
  type: "member.complete";
  memberKey: string;
};
export type CouncilScoringStartEvent = { type: "scoring.start" };
export type CouncilScoreEvent = {
  type: "score";
  scorerKey: string;
  targetKey: string;
  score: number | null;
};
export type CouncilScoringCompleteEvent = {
  type: "scoring.complete";
  averages: Record<string, number | null>;
};

export type CouncilEvent =
  | CouncilMemberStartEvent
  | CouncilMemberTokenEvent
  | CouncilMemberCompleteEvent
  | CouncilScoringStartEvent
  | CouncilScoreEvent
  | CouncilScoringCompleteEvent
  | ErrorEvent
  | DoneEvent;

// Case 5 — Synthesis (extends Council)
export type SynthesisStartEvent = {
  type: "synthesis.start";
  modelId: string;
  messageId: string;
};
export type SynthesisTokenEvent = { type: "synthesis.token"; delta: string };
export type SynthesisCompleteEvent = { type: "synthesis.complete" };

export type SynthesisEvent =
  | CouncilEvent
  | SynthesisStartEvent
  | SynthesisTokenEvent
  | SynthesisCompleteEvent;

export type AnyChatEvent =
  | SingleEvent
  | FanoutEvent
  | LoopEvent
  | CouncilEvent
  | SynthesisEvent;
