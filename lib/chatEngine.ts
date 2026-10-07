import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages as messagesTable } from "@/lib/db/schema";
import {
  getRecentMessages,
  KEYWORD_SCAN_WINDOW,
  matchWorldbook,
  searchVectorMemories,
  storeEmbedding,
  VERBATIM_WINDOW,
} from "@/lib/memory";
import { buildSystemPrompt } from "@/lib/prompt";
import { streamChat } from "@/lib/llm";
import { modelFor, type AppSettings } from "@/lib/settings";
import type { CharacterCard, Mode, WbEntry } from "@/lib/types";

/**
 * 单角色一轮回复的完整生成流程（单聊与群聊共用）：
 * 窗口 → 世界书命中（该角色自己的世界书）→ 向量检索 → prompt → 流式生成 → 落库 → 向量入库。
 *
 * 调用方通过 emit 收到 SSE 事件：{t:"hits"} → {t:"tok"}*；结束后由调用方发 done / speaker_done。
 * 群聊时历史消息会带上「（名字）：」前缀，让模型知道每句话是谁说的。
 * 摘要更新（maybeUpdateSummary）由调用方在整轮结束后执行一次，本模块不管。
 */

export type EmitFn = (obj: unknown) => void;

export type EngineParams = {
  conversationId: string;
  mode: Mode;
  tier: "light" | "quality";
  chapter: number;
  /** 本轮的滚动摘要（调用方在轮开始时读取） */
  summary: string;
  character: CharacterCard;
  /** 该角色自己的世界书条目（群聊中按角色独立命中） */
  entries: WbEntry[];
  wbMaxHits: number;
  isGroup: boolean;
  /** 群聊成员名字映射（含自己），用于历史消息署名前缀 */
  memberNameById: Record<string, string>;
  /** 群聊中除自己以外的成员名（system prompt 用） */
  groupOthers: string[];
  /** 触发本轮的用户消息文本（重Roll 时传空串，检索会退回窗口内最后一条用户消息） */
  content: string;
  emotion: string | null;
  /** 需要向量化的一条用户消息 id（重Roll/群聊非首发言者传 null 跳过） */
  embedMessageId: string | null;
  embedMessageContent: string;
  /** 分支树：本条回复挂载的父消息 id（用户消息/上一发言者的回复；null = 成为根） */
  parentId: string | null;
  /** 生成上下文时从活跃路径剔除的消息 id（重Roll 时 = 被替换的旧回复） */
  contextExcludeIds?: string[];
};

export async function generateOneReply(
  p: EngineParams,
  settings: AppSettings,
  emit: EmitFn,
): Promise<{ assistantId: string; full: string }> {
  const recent = getRecentMessages(p.conversationId, VERBATIM_WINDOW, p.contextExcludeIds ?? []);

  const hits = matchWorldbook(
    p.entries,
    recent.slice(-KEYWORD_SCAN_WINDOW).map((m) => m.content),
    p.wbMaxHits,
  );
  emit({
    t: "hits",
    hits: hits.map((h) => ({ category: h.category, title: h.title, weight: h.weight })),
    speaker: p.isGroup ? p.character.name : undefined,
  });

  const recentIds = recent.map((m) => m.id);
  let vectorMemories: { chunk: string; score: number }[] = [];
  const queryText = p.content || recent.findLast((m) => m.role === "user")?.content || "";
  if (queryText) {
    try {
      vectorMemories = await searchVectorMemories(p.conversationId, queryText, recentIds);
    } catch (err) {
      console.error("[chat] 向量检索失败（忽略）:", err);
    }
  }

  const system = buildSystemPrompt({
    character: p.character,
    mode: p.mode,
    summary: p.summary,
    worldbookHits: hits,
    vectorMemories,
    emotion: p.emotion,
    chapter: p.chapter,
    groupOthers: p.isGroup ? p.groupOthers : undefined,
  });

  const chatMessages = [
    { role: "system" as const, content: system },
    ...recent.map((m) => ({
      role: m.role as "user" | "assistant",
      content:
        p.isGroup && m.role === "assistant" && m.characterId
          ? `（${p.memberNameById[m.characterId] ?? "角色"}）：${m.content}`
          : m.content,
    })),
  ];

  let full = "";
  for await (const token of streamChat({
    config: modelFor(settings, p.tier),
    messages: chatMessages,
    mockHint: { kind: "chat", characterName: p.character.name, userText: queryText || p.content, mode: p.mode },
  })) {
    full += token;
    emit({ t: "tok", v: token });
  }

  // 回复落库（idx 取当前消息数，兼容同一轮多个发言者依次入库）
  const assistantId = crypto.randomUUID();
  const nextIdx = db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, p.conversationId))
    .all().length;
  db.insert(messagesTable)
    .values({
      id: assistantId,
      conversationId: p.conversationId,
      idx: nextIdx,
      role: "assistant",
      content: full,
      characterId: p.isGroup ? p.character.id : null,
      parentId: p.parentId,
      createdAt: Date.now(),
    })
    .run();
  // 让父消息的活跃子分支指向自己，新回复立即可见（旧分支保留可切回）；
  // 没有父消息（成为根，如空会话首条/根级重Roll）则更新会话的活跃根
  if (p.parentId) {
    db.update(messagesTable)
      .set({ activeChildId: assistantId })
      .where(eq(messagesTable.id, p.parentId))
      .run();
  } else {
    db.update(conversations)
      .set({ activeRootId: assistantId })
      .where(eq(conversations.id, p.conversationId))
      .run();
  }

  try {
    if (p.embedMessageId) {
      await storeEmbedding(p.conversationId, p.embedMessageId, p.embedMessageContent);
    }
    await storeEmbedding(p.conversationId, assistantId, full);
  } catch (err) {
    console.error("[chat] 向量入库失败（忽略）:", err);
  }

  return { assistantId, full };
}
