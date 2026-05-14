import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "./client";
import {
  conversations,
  messages,
  runs,
  scores,
  type Conversation,
  type Message,
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
  patch: Partial<Pick<Message, "content" | "status">>,
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
