import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "./client";
import {
  conversations,
  messages,
  runs,
  scores,
  type Conversation,
  type Message,
  type MessageAttachment,
  type NewConversation,
  type NewMessage,
  type NewRun,
  type Score,
} from "./schema";

export async function listConversations(): Promise<Conversation[]> {
  return db.select().from(conversations).orderBy(desc(conversations.updatedAt));
}

export async function createConversation(data: NewConversation): Promise<Conversation> {
  const [row] = await db.insert(conversations).values(data).returning();
  return row;
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return row;
}

export async function updateConversationTitle(id: string, title: string): Promise<void> {
  await db
    .update(conversations)
    .set({ title, updatedAt: new Date() })
    .where(eq(conversations.id, id));
}

/**
 * Deletes a conversation and (via `ON DELETE CASCADE`) its messages, scores,
 * and runs. Returns the deleted row so callers can decide whether mode-specific
 * cleanup is needed (e.g. removing on-disk generated images for `imagine`).
 */
export async function deleteConversation(id: string): Promise<Conversation | undefined> {
  const [row] = await db
    .delete(conversations)
    .where(eq(conversations.id, id))
    .returning();
  return row;
}

export async function listMessages(conversationId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

export async function insertMessage(data: NewMessage): Promise<Message> {
  const [row] = await db.insert(messages).values(data).returning();
  return row;
}

/**
 * Upserts the user-side message when a fanout submit issues N parallel requests
 * with the same `clientMessageId`. Returns the existing row if one was already
 * created, otherwise the freshly inserted row.
 */
export async function upsertUserMessage(data: NewMessage & {
  clientMessageId: string;
}): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values(data)
    .onConflictDoNothing({
      target: [messages.conversationId, messages.clientMessageId],
    })
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, data.conversationId),
        eq(messages.clientMessageId, data.clientMessageId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("upsertUserMessage: row neither inserted nor found");
  return existing;
}

export async function updateMessage(
  id: string,
  patch: Partial<Pick<Message, "content" | "status" | "attachments">>,
): Promise<void> {
  await db.update(messages).set(patch).where(eq(messages.id, id));
}

export async function listScores(conversationId: string): Promise<Score[]> {
  return db
    .select()
    .from(scores)
    .where(eq(scores.conversationId, conversationId));
}

export async function insertScore(data: typeof scores.$inferInsert): Promise<Score> {
  const [row] = await db.insert(scores).values(data).returning();
  return row;
}

export async function averagesByTarget(
  conversationId: string,
): Promise<Record<string, number | null>> {
  const rows = await db
    .select({
      targetId: scores.targetMessageId,
      avg: sql<number | null>`avg(${scores.score})`.as("avg"),
    })
    .from(scores)
    .where(eq(scores.conversationId, conversationId))
    .groupBy(scores.targetMessageId);

  const out: Record<string, number | null> = {};
  for (const r of rows) {
    out[r.targetId] = r.avg === null ? null : Number(r.avg);
  }
  return out;
}

export async function startRun(data: NewRun) {
  const [row] = await db.insert(runs).values(data).returning();
  return row;
}

export async function endRun(
  id: string,
  status: "complete" | "aborted" | "error",
  error?: string,
): Promise<void> {
  await db
    .update(runs)
    .set({ status, endedAt: new Date(), error: error ?? null })
    .where(eq(runs.id, id));
}

export type ChatHistoryEntry = {
  conversationId: string;
  mode: Conversation["mode"];
  title: string;
  firstUserPrompt: string;
  lastAssistantSnippet: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function listChatHistory(limit = 200): Promise<ChatHistoryEntry[]> {
  const convoRows = await db
    .select()
    .from(conversations)
    .where(sql`${conversations.mode} NOT IN ('imagine', 'animate', 'music')`)
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);

  if (convoRows.length === 0) return [];

  const convoIds = convoRows.map((c) => c.id);
  const msgRows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(inArray(messages.conversationId, convoIds))
    .orderBy(asc(messages.createdAt));

  const grouped = new Map<
    string,
    { firstUser: string; lastAssistant: string; count: number }
  >();
  for (const m of msgRows) {
    const g = grouped.get(m.conversationId) ?? {
      firstUser: "",
      lastAssistant: "",
      count: 0,
    };
    g.count++;
    if (m.role === "user" && !g.firstUser) g.firstUser = m.content;
    if (
      (m.role === "assistant" || m.role === "synthesizer") &&
      m.content
    )
      g.lastAssistant = m.content;
    grouped.set(m.conversationId, g);
  }

  return convoRows.map((c) => {
    const g = grouped.get(c.id);
    return {
      conversationId: c.id,
      mode: c.mode,
      title: c.title,
      firstUserPrompt: g?.firstUser ?? "",
      lastAssistantSnippet: g?.lastAssistant ?? "",
      messageCount: g?.count ?? 0,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });
}

export type ImagineGalleryEntry = {
  conversationId: string;
  conversationTitle: string;
  assistantMessageId: string;
  modelId: string | null;
  prompt: string;
  attachments: MessageAttachment[];
  createdAt: Date;
};

export async function listImagineGallery(limit = 200): Promise<ImagineGalleryEntry[]> {
  return listGalleryByMode("imagine", limit);
}

export type AnimateGalleryEntry = ImagineGalleryEntry;

export async function listAnimateGallery(limit = 200): Promise<AnimateGalleryEntry[]> {
  return listGalleryByMode("animate", limit);
}

export type MusicGalleryEntry = ImagineGalleryEntry;

export async function listMusicGallery(limit = 200): Promise<MusicGalleryEntry[]> {
  return listGalleryByMode("music", limit);
}

async function listGalleryByMode(
  mode: "imagine" | "animate" | "music",
  limit: number,
): Promise<ImagineGalleryEntry[]> {
  const rows = await db
    .select({
      conversationId: messages.conversationId,
      conversationTitle: conversations.title,
      assistantMessageId: messages.id,
      modelId: messages.modelId,
      parentId: messages.parentId,
      attachments: messages.attachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.mode, mode),
        eq(messages.role, "assistant"),
        isNotNull(messages.parentId),
        sql`jsonb_array_length(${messages.attachments}) > 0`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  const parentIds = Array.from(
    new Set(rows.map((r) => r.parentId).filter((id): id is string => id !== null)),
  );
  const parents = parentIds.length
    ? await db
        .select({ id: messages.id, content: messages.content })
        .from(messages)
        .where(inArray(messages.id, parentIds))
    : [];
  const promptById = new Map(parents.map((p) => [p.id, p.content]));

  return rows.map((r) => ({
    conversationId: r.conversationId,
    conversationTitle: r.conversationTitle,
    assistantMessageId: r.assistantMessageId,
    modelId: r.modelId,
    prompt: r.parentId ? promptById.get(r.parentId) ?? "" : "",
    attachments: r.attachments,
    createdAt: r.createdAt,
  }));
}
