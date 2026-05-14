import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const conversationModeEnum = pgEnum("conversation_mode", [
  "single",
  "fanout",
  "loop",
  "council",
  "synthesis",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
  "scorer",
  "synthesizer",
]);

export const messageStatusEnum = pgEnum("message_status", [
  "streaming",
  "complete",
  "aborted",
  "error",
]);

export const runStatusEnum = pgEnum("run_status", [
  "running",
  "complete",
  "aborted",
  "error",
]);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  mode: conversationModeEnum("mode").notNull(),
  title: text("title").notNull().default(""),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    role: messageRoleEnum("role").notNull(),
    modelId: text("model_id"),
    paneKey: text("pane_key"),
    round: integer("round"),
    content: text("content").notNull().default(""),
    status: messageStatusEnum("status").notNull().default("complete"),
    clientMessageId: text("client_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byConversation: index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    clientDedupe: uniqueIndex("messages_client_dedupe_idx").on(
      t.conversationId,
      t.clientMessageId,
    ),
  }),
);

export const scores = pgTable(
  "scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    scorerMessageId: uuid("scorer_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    targetMessageId: uuid("target_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    scorerModelId: text("scorer_model_id").notNull(),
    targetModelId: text("target_model_id").notNull(),
    score: integer("score"),
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTarget: index("scores_target_idx").on(t.targetMessageId),
    byConversation: index("scores_conversation_idx").on(t.conversationId),
  }),
);

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  mode: conversationModeEnum("mode").notNull(),
  status: runStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  error: text("error"),
});

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Score = typeof scores.$inferSelect;
export type NewScore = typeof scores.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
