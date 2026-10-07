import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages as messagesTable } from "@/lib/db/schema";
import { getActivePath, nextIdx } from "@/lib/branch";
import {
  getCharacterCard,
  getWorldbookEntriesForCharacter,
  maybeUpdateSummary,
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
 *      （v1.5 分支树：重Roll 不再删除旧回复，新回复作为兄弟分支挂到同一父节点下，
 *        旧分支保留可切回；rerollMessageId 是要重Roll 的那条回复；不传则对活跃路径
 *        末尾操作——末尾是用户消息时直接续写，这是编辑重发走的路径）
 *
 * 单聊事件：{t:"hits"} → {t:"tok"}* → {t:"done", messageId, userMessageId, summary}
 * 群聊事件：{t:"speakers", speakers:[…]} → ({t:"speaker"} → {t:"hits"} → {t:"tok"}* →
 *           {t:"speaker_done", messageId})* → {t:"done", userMessageId, summary}
 *           被选中的发言者按顺序逐个生成，后发言者能看到前者本轮的发言。
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

  // 1. 分支树定位 + 落库。
  //    活跃路径叶子决定挂载点：普通发送 → 用户消息挂在叶子下；
  //    重Roll → 不再删除旧回复，新回复作为「兄弟分支」挂到被替换消息的父节点下；
  //    编辑重发（末尾是用户消息）→ 直接续写为该用户消息的子分支。
  const path = getActivePath(conversationId);
  const leaf = path.at(-1);

  let userMsgId = "__reroll__";
  let rerollSpeakerId: string | null = null;
  /** 本轮第一条回复的挂载父消息；null = 成为根（空会话/根级重Roll） */
  let firstReplyParentId: string | null;
  /** 生成上下文时要剔除的消息（被重Roll 的旧回复本身，避免模型把它当成上文续写） */
  const contextExcludeIds: string[] = [];

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
      rerollSpeakerId = target.characterId;
      contextExcludeIds.push(target.id);
      firstReplyParentId = target.role === "assistant" ? target.parentId : target.id;
    } else if (leaf?.role === "assistant") {
      rerollSpeakerId = leaf.characterId;
      contextExcludeIds.push(leaf.id);
      firstReplyParentId = leaf.parentId;
    } else {
      // 末尾是用户消息（编辑重发后）→ 续写
      firstReplyParentId = leaf?.id ?? null;
    }
  } else {
    userMsgId = crypto.randomUUID();
    db.insert(messagesTable)
      .values({
        id: userMsgId,
        conversationId,
        idx: nextIdx(conversationId),
        role: "user",
        content,
        characterId: null,
        parentId: leaf?.id ?? null,
        emotion: body.emotion || null,
        createdAt: Date.now(),
      })
      .run();
    if (leaf) {
      db.update(messagesTable)
        .set({ activeChildId: userMsgId })
        .where(eq(messagesTable.id, leaf.id))
        .run();
    }
    firstReplyParentId = userMsgId;
  }
  db.update(conversations)
    .set({ updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run();

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

  if (speakers.length === 0) {
    return Response.json({ error: "没有可发言的成员" }, { status: 400 });
  }

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
      // 群聊一轮多个发言者按顺序链式挂接（B 的父是 A），保证「单活跃子指针」路径完整
      let prevReplyParentId: string | null = firstReplyParentId;
      try {
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
              parentId: prevReplyParentId,
              contextExcludeIds,
            },
            settings,
            emit,
          );
          lastAssistantId = r.assistantId;
          prevReplyParentId = r.assistantId;
          if (isGroup) {
            emit({ t: "speaker_done", characterId: sp.card.id, messageId: r.assistantId });
          }
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
        // 用户消息在流开始前已落库：把真实 id 随 err 带回，客户端气泡才能保留可编辑的锚点
        emit({
          t: "err",
          message: err instanceof Error ? err.message : String(err),
          userMessageId: isReroll ? undefined : userMsgId,
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
