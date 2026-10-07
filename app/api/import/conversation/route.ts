import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  characters,
  conversations,
  messages as messagesTable,
  worldbooks,
} from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * 会话导入（对应 /api/export?format=json 的 himuro-chat 格式）。
 * POST body 即导出的 JSON：重建会话与消息（新的 id、线性父链），
 * 星标/情绪/模式/章节/摘要原样保留；发言人按 id 优先、名字兜底映射到现有角色，
 * 匹配不到且导出内嵌了角色卡时自动建卡（含世界书）。
 */

type ImportPayload = {
  format?: string;
  conversation?: {
    title?: string;
    mode?: string;
    tier?: string;
    chapter?: number;
    summary?: string;
    characterId?: string;
  };
  character?: Record<string, unknown> | null;
  messages?: {
    role?: string;
    speaker?: string | null;
    speakerCharacterId?: string | null;
    content?: string;
    emotion?: string | null;
    starred?: boolean;
    createdAt?: number;
  }[];
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ImportPayload | null;
  if (!body || body.format !== "himuro-chat" || !body.conversation || !Array.isArray(body.messages)) {
    return Response.json({ error: "不是合法的 Himuro 会话导出文件" }, { status: 400 });
  }
  if (body.messages.length === 0) {
    return Response.json({ error: "导出文件里没有消息" }, { status: 400 });
  }

  const c = body.conversation;
  const now = Date.now();
  const uid = () => crypto.randomUUID();
  const characterExists = (id: string) =>
    Boolean(db.select({ id: characters.id }).from(characters).where(eq(characters.id, id)).get());

  // 1. 定位角色：导出的 characterId → 消息里的 speakerCharacterId → 内嵌角色卡名字 → 自动建卡
  let characterId: string | null = null;
  for (const cid of [c.characterId, ...body.messages.map((m) => m.speakerCharacterId)]) {
    if (cid && characterExists(cid)) {
      characterId = cid;
      break;
    }
  }

  const cardName = (body.character?.name as string) ?? "";
  if (!characterId && cardName) {
    characterId =
      db.select({ id: characters.id }).from(characters).where(eq(characters.name, cardName)).get()?.id ??
      null;
  }
  if (!characterId && cardName) {
    // 自动建卡（含世界书），设定来自导出内嵌的角色卡
    characterId = uid();
    db.insert(characters)
      .values({
        id: characterId,
        name: cardName,
        identity: (body.character?.identity as string) ?? "",
        speechStyle: (body.character?.speechStyle as string) ?? "",
        relationship: (body.character?.relationship as string) ?? "",
        firstMessage: "",
        isTemplate: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(worldbooks)
      .values({ id: uid(), characterId, name: `${cardName}的世界书`, createdAt: now })
      .run();
  }
  if (!characterId) {
    return Response.json({ error: "找不到对应角色，请先导入对应的角色卡" }, { status: 400 });
  }

  // 2. 建会话 + 线性消息链
  const conversationId = uid();
  const mode = c.mode === "story" ? "story" : "daily";
  const tier = c.tier === "quality" ? "quality" : "light";
  db.insert(conversations)
    .values({
      id: conversationId,
      characterId,
      title: `${c.title || "导入的会话"}（导入）`,
      mode,
      tier,
      chapter: Math.max(1, Number(c.chapter) || 1),
      summaryText: c.summary ?? "",
      summarizedCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // 发言人名字 → 角色 id 映射（导出只有名字时兜底）
  const nameMap = new Map<string, string>();
  for (const name of body.messages.map((m) => m.speaker).filter((x): x is string => Boolean(x))) {
    if (nameMap.has(name)) continue;
    const row = db.select({ id: characters.id }).from(characters).where(eq(characters.name, name)).get();
    if (row) nameMap.set(name, row.id);
  }

  let imported = 0;
  let prevId: string | null = null;
  db.transaction((tx) => {
    body.messages!.forEach((m, i) => {
      const id = uid();
      let speaker: string | null = null;
      if (m.role !== "user") {
        if (m.speakerCharacterId && characterExists(m.speakerCharacterId)) {
          speaker = m.speakerCharacterId;
        } else if (m.speaker && nameMap.has(m.speaker)) {
          speaker = nameMap.get(m.speaker)!;
        } else {
          speaker = characterId; // 兜底：会话主角色
        }
      }
      tx.insert(messagesTable)
        .values({
          id,
          conversationId,
          idx: i,
          role: m.role === "user" ? "user" : "assistant",
          content: m.content ?? "",
          characterId: speaker,
          parentId: prevId,
          emotion: m.emotion ?? null,
          starred: m.starred ? 1 : 0,
          createdAt: m.createdAt ?? now,
        })
        .run();
      prevId = id;
      imported++;
    });
  });

  return Response.json({ id: conversationId, characterId, imported });
}
