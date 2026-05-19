import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { NextResponse } from "next/server";
import {
  averagesByTarget,
  deleteConversation,
  getConversation,
  listMessages,
  listScores,
  updateConversationTitle,
} from "@/lib/db/queries";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUBLIC_GENERATED_DIR = resolve(process.cwd(), "public", "generated");
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const conversation = await getConversation(id);
  if (!conversation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [messages, scores, averages] = await Promise.all([
    listMessages(id),
    listScores(id),
    averagesByTarget(id),
  ]);
  return NextResponse.json({ conversation, messages, scores, averages });
}

const PatchBody = z.object({
  title: z.string().max(200),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await updateConversationTitle(id, parsed.data.title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const row = await deleteConversation(id);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let filesRemoved = false;
  if (row.mode === "imagine" || row.mode === "animate") {
    // Guard against any future path-trickery: resolve the target and confirm
    // it lives strictly inside PUBLIC_GENERATED_DIR before recursive rm.
    const target = resolve(join(PUBLIC_GENERATED_DIR, id));
    if (target === PUBLIC_GENERATED_DIR || !target.startsWith(PUBLIC_GENERATED_DIR + sep)) {
      return NextResponse.json(
        { ok: true, mode: row.mode, filesRemoved: false, warning: "skipped suspicious path" },
      );
    }
    try {
      await rm(target, { recursive: true, force: true });
      filesRemoved = true;
    } catch (err) {
      return NextResponse.json(
        {
          ok: true,
          mode: row.mode,
          filesRemoved: false,
          warning: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return NextResponse.json({ ok: true, mode: row.mode, filesRemoved });
}
