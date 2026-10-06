import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages as messagesTable, msgChunks } from "@/lib/db/schema";
import {
  getCharacterCard,
  getWorldbookEntriesForCharacter,
  maybeUpdateSummary,
  renumberMessages,
} from "@/lib/memory";
import { generateOneReply, type EmitFn } from "@/lib/chatEngine";
import {
  getConversationMembers,
  lastSpeakerCharacterId,
  selectSpeakers,
} from "@/lib/group";
import type { GroupStrategy } from "@/lib/types";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 聊天接口（SSE 流式；单聊与群聊共用）。
 *
 * 请求：{ conversationId, content, emotion? }
 *      或重Roll：{ conversationId, reroll: true, rerollMessageId? }
 *      （rerollMessageId 是要替换的那条角色回复；不传则对最后一条角色回复重Roll；
 *        末尾是用户消息时直接续写——编辑重发用这个路径）
 *
 * 重Roll 的落库顺序：旧回复在新回复生成成功之前一直留在库里，只是不进 prompt 窗口；
 * 这样上游超时/限流时不会出现「旧的删了、新的没生成」的空档。
 *
 * 单聊事件：{t:"user_msg", id} → {t:"hits"} → {t:"tok"}* → {t:"done", messageId, userMessageId, summary}
 * 群聊事件：{t:"user_msg", id} → {t:"speakers", speakers:[…]} → ({t:"speaker"} → {t:"hits"} →
 *           {t:"tok"}* → {t:"speaker_done", messageId})* → {t:"done", userMessageId, summary}
 *           被选中的发言者按顺序逐个生成，后发言者能看到前者本轮的发言。
 * 出错事件：{t:"err", message}（流已开、回复没生成完；用户消息此时已落库，客户端要按真 id 保留）
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

  const settings = getSettings();
  const members = getConversationMembers(conversationId);
  const isGroup = members.length >= 2;

  // 单聊需要会话角色存在；群聊只看成员
  if (!isGroup) {
    const character = getCharacterCard(conv.characterId);
    if (!character) {
      return Response.json({ error: "角色不存在" }, { status: 404 });
    }
  }

  // 1. 重Roll 的落点：先只读出来，不删。删行动作推迟到新回复生成成功之后——
  //    上游超时/限流时旧回复还在，不会出现「服务端删了、新的又没生成」两头空。
  //    被替换的那条同时从 prompt 窗口里排除，否则模型看见自己上一句会照着再答一遍。
  let rerollTargetId: string | null = null;
  let rerollSpeakerId: string | null = null;
  if (isReroll) {
    if (body.rerollMessageId) {
      const target = db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.id, body.rerollMessageId))
        .get();
      if (!target || target.conversationId !== conversationId) {
        return Response.json({ error: "要重Roll的消息不存在" }, { status: 404 });
      }
      rerollTargetId = target.id;
      rerollSpeakerId = target.characterId;
    } else {
      const last = db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.conversationId, conversationId))
        .all()
        .at(-1);
      if (last?.role === "assistant") {
        rerollTargetId = last.id;
        rerollSpeakerId = last.characterId;
      }
      // 末尾是用户消息（编辑重发后）→ 不删，直接续写
    }
  }

  // 2. 确定本轮发言者（群聊按策略；单聊固定为会话角色）
  const lastSpeaker = lastSpeakerCharacterId(conversationId);
  const singleCard = isGroup ? null : getCharacterCard(conv.characterId)!;
  const singleEntries = isGroup ? [] : getWorldbookEntriesForCharacter(conv.characterId).entries;

  const speakers = isGroup
    ? selectSpeakers(
        (conv.groupStrategy as GroupStrategy) ?? "mention",
        members,
        content,
        lastSpeaker,
        rerollSpeakerId,
      )
    : [
        {
          characterId: conv.characterId,
          sort: 0,
          card: singleCard!,
          entries: singleEntries,
        },
      ];

  // 先判定再落库：没有可发言的成员时直接 400，不给用户消息留下孤儿行
  if (speakers.length === 0) {
    return Response.json({ error: "没有可发言的成员" }, { status: 400 });
  }

  // 3. 落库：普通发送插入用户消息；重Roll 不动库（旧行留到新回复生成成功）
  let userMsgId = "";
  if (!isReroll) {
    userMsgId = crypto.randomUUID();
    db.insert(messagesTable)
      .values({
        id: userMsgId,
        conversationId,
        idx: db
          .select({ id: messagesTable.id })
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conversationId))
          .all().length,
        role: "user",
        content,
        characterId: null,
        emotion: body.emotion || null,
        createdAt: Date.now(),
      })
      .run();
  }
  db.update(conversations)
    .set({ updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run();

  const memberNameById: Record<string, string> = {};
  if (isGroup) {
    for (const m of members) memberNameById[m.characterId] = m.card.name;
    // 被重Roll 的角色可能已不在成员列表（被移出群聊后重Roll 旧消息），补进映射
    for (const s of speakers) memberNameById[s.characterId] = s.card.name;
  }

  const encoder = new TextEncoder();
  const emit: EmitFn = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  let controller!: ReadableStreamDefaultController;

  const stream = new ReadableStream({
    async start(ctrl) {
      controller = ctrl;
      let lastAssistantId = "";
      try {
        // 先把手里的用户消息真 id 发出去：流中断时客户端也不会拿着一个伪造 id
        // 去执行编辑/删除/星标（那些操作都按 id 找服务端的行）
        if (userMsgId) emit({ t: "user_msg", id: userMsgId });

        if (isGroup) {
          emit({
            t: "speakers",
            speakers: speakers.map((s) => ({
              characterId: s.card.id,
              name: s.card.name,
              emoji: s.card.emoji,
            })),
          });
        }

        for (let i = 0; i < speakers.length; i++) {
          const sp = speakers[i];
          if (isGroup) {
            emit({ t: "speaker", characterId: sp.card.id, name: sp.card.name, emoji: sp.card.emoji });
          }
          const r = await generateOneReply(
            {
              conversationId,
              mode: conv.mode as "daily" | "story",
              tier: conv.tier as "light" | "quality",
              chapter: conv.chapter,
              summary: conv.summaryText,
              character: sp.card,
              entries: sp.entries,
              wbMaxHits: settings.wbMaxHits,
              isGroup,
              memberNameById,
              groupOthers: members.filter((m) => m.characterId !== sp.characterId).map((m) => m.card.name),
              content: i === 0 ? content : "",
              emotion: body.emotion || null,
              embedMessageId: !isReroll && i === 0 ? userMsgId : null,
              embedMessageContent: content,
              excludeMessageIds: rerollTargetId ? [rerollTargetId] : undefined,
            },
            settings,
            emit,
          );
          lastAssistantId = r.assistantId;
          if (isGroup) {
            emit({ t: "speaker_done", characterId: sp.card.id, messageId: r.assistantId });
          }
        }

        // 重Roll：新回复已经落库，到这里才删被替换的旧行（含向量块），并重排 idx
        if (rerollTargetId) {
          db.delete(msgChunks).where(eq(msgChunks.messageId, rerollTargetId)).run();
          db.delete(messagesTable).where(eq(messagesTable.id, rerollTargetId)).run();
          renumberMessages(conversationId);
        }

        // 记忆更新（失败不阻塞回复展示）
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

        emit({
          t: "done",
          messageId: lastAssistantId,
          userMessageId: isReroll ? null : userMsgId,
          summary: summaryText,
        });
      } catch (err) {
        emit({
          t: "err",
          message: err instanceof Error ? err.message : String(err),
        });
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
