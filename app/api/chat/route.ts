import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages as messagesTable, msgChunks } from "@/lib/db/schema";
import {
  getCharacterCard,
  getRecentMessages,
  getWorldbookEntriesForCharacter,
  KEYWORD_SCAN_WINDOW,
  matchWorldbook,
  maybeUpdateSummary,
  searchVectorMemories,
  storeEmbedding,
  VERBATIM_WINDOW,
} from "@/lib/memory";
import { buildSystemPrompt } from "@/lib/prompt";
import { streamChat, type ChatMessage } from "@/lib/llm";
import { getSettings, modelFor } from "@/lib/settings";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 聊天接口（SSE 流式）。
 *
 * 请求：{ conversationId, content, emotion? }
 *      或重Roll：{ conversationId, reroll: true, rerollMessageId? }
 *      （rerollMessageId 是要替换的那条角色回复；不传则对最后一条角色回复重Roll）
 * 事件：{ t:"tok", v } 增量文本
 *      { t:"done", messageId, hits, summary } 结束（hits=本轮世界书命中，summary=最新摘要）
 *      { t:"err", message } 出错
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    conversationId?: string;
    content?: string;
    emotion?: string;
    reroll?: boolean;
    rerollMessageId?: string;
  };
  const conversationId = body.conversationId;
  const content = (body.content ?? "").trim();
  const isReroll = body.reroll === true;
  if (!conversationId || (!isReroll && !content)) {
    return Response.json({ error: "缺少 conversationId 或 content" }, { status: 400 });
  }

  const conv = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!conv) {
    return Response.json({ error: "会话不存在" }, { status: 404 });
  }

  const character = getCharacterCard(conv.characterId);
  if (!character) {
    return Response.json({ error: "角色不存在" }, { status: 404 });
  }

  // 1. 落库：普通发送 → 插入用户消息；重Roll → 删掉被替换的角色回复（含向量块）
  const allCount = db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .all().length;

  let userMsgId: string;
  if (isReroll) {
    if (body.rerollMessageId) {
      // 指定了要替换的回复：删掉它（含向量块）
      db.delete(msgChunks).where(eq(msgChunks.messageId, body.rerollMessageId)).run();
      db.delete(messagesTable).where(eq(messagesTable.id, body.rerollMessageId)).run();
    } else {
      // 未指定：末尾是角色回复则删掉重生成；末尾是用户消息（编辑重发后）则直接续写
      const last = db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.conversationId, conversationId))
        .all()
        .at(-1);
      if (last?.role === "assistant") {
        db.delete(msgChunks).where(eq(msgChunks.messageId, last.id)).run();
        db.delete(messagesTable).where(eq(messagesTable.id, last.id)).run();
      }
    }
    userMsgId = "__reroll__"; // 占位：本轮没有新的用户消息需要入库/向量化
  } else {
    userMsgId = crypto.randomUUID();
    db.insert(messagesTable)
      .values({
        id: userMsgId,
        conversationId,
        idx: allCount,
        role: "user",
        content,
        emotion: body.emotion || null,
        createdAt: Date.now(),
      })
      .run();
  }
  db.update(conversations)
    .set({ updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run();

  // 2. 组装 prompt：最近窗口 + 世界书命中 + 向量回忆 + 摘要
  const recent = getRecentMessages(conversationId, VERBATIM_WINDOW);
  const { entries } = getWorldbookEntriesForCharacter(conv.characterId);
  const settings = getSettings();
  const hits = matchWorldbook(
    entries,
    recent.slice(-KEYWORD_SCAN_WINDOW).map((m) => m.content),
    settings.wbMaxHits,
  );

  const recentIds = recent.map((m) => m.id);
  // 向量检索的查询文本：普通发送用刚输入的内容；重Roll用窗口内最后一条用户消息
  const lastUser = [...recent].reverse().find((m) => m.role === "user");
  const queryText = isReroll ? (lastUser?.content ?? "") : content;
  let vectorMemories: { chunk: string; score: number }[] = [];
  try {
    vectorMemories = await searchVectorMemories(conversationId, queryText, recentIds);
  } catch (err) {
    console.error("[chat] 向量检索失败（忽略）:", err);
  }

  const system = buildSystemPrompt({
    character,
    mode: conv.mode as "daily" | "story",
    summary: conv.summaryText,
    worldbookHits: hits,
    vectorMemories,
    emotion: body.emotion || null,
    chapter: conv.chapter,
  });

  const chatMessages: ChatMessage[] = [
    { role: "system", content: system },
    ...recent.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];
  // 3. 流式调用
  const tier = conv.tier as "light" | "quality";
  const encoder = new TextEncoder();
  const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      let full = "";
      try {
        controller.enqueue(sse({ t: "hits", hits: hits.map((h) => ({ category: h.category, title: h.title, weight: h.weight })) }));
        for await (const token of streamChat({
          config: modelFor(settings, tier),
          messages: chatMessages,
          mockHint: { kind: "chat", characterName: character.name, userText: queryText, mode: conv.mode as "daily" | "story" },
        })) {
          full += token;
          controller.enqueue(sse({ t: "tok", v: token }));
        }

        // 4. 回复入库（idx 取当前消息数，兼容重Roll场景）+ 记忆更新（失败不阻塞回复展示）
        const assistantId = crypto.randomUUID();
        const nextIdx = db
          .select({ id: messagesTable.id })
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conversationId))
          .all().length;
        db.insert(messagesTable)
          .values({
            id: assistantId,
            conversationId,
            idx: nextIdx,
            role: "assistant",
            content: full,
            createdAt: Date.now(),
          })
          .run();

        try {
          if (!isReroll) await storeEmbedding(conversationId, userMsgId, content);
          await storeEmbedding(conversationId, assistantId, full);
        } catch (err) {
          console.error("[chat] 向量入库失败（忽略）:", err);
        }

        let summaryText = conv.summaryText;
        try {
          await maybeUpdateSummary(conversationId);
          summaryText =
            db
              .select({ s: conversations.summaryText })
              .from(conversations)
              .where(eq(conversations.id, conversationId))
              .get()?.s ?? summaryText;
        } catch (err) {
          console.error("[chat] 摘要更新失败（忽略）:", err);
        }

        controller.enqueue(
          sse({
            t: "done",
            messageId: assistantId,
            userMessageId: isReroll ? null : userMsgId,
            summary: summaryText,
          }),
        );
      } catch (err) {
        controller.enqueue(
          sse({
            t: "err",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
