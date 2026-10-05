import "server-only";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  characters,
  conversations,
  messages as messagesTable,
  msgChunks,
  wbEntries,
  worldbooks,
} from "@/lib/db/schema";
import { chatComplete, cosineSim, embedTexts } from "@/lib/llm";
import { buildSummaryMessages } from "@/lib/prompt";
import { getSettings, modelFor } from "@/lib/settings";
import { parseExamples, type CharacterCard, type WbEntry } from "@/lib/types";

/**
 * 三层长会话记忆（对应报告建议，不做过头）：
 *   1. 滚动摘要   —— 每累计 N 条把更早的历史压缩成 300 字内摘要
 *   2. 世界书命中 —— 扫描最近消息文本，命中关键词的条目按权重注入
 *   3. 向量检索   —— 可选。配置了 Embedding 才启用，按语义找回更早的片段
 */

/** 进入 prompt 的最近原文消息条数（更早的靠摘要/向量兜底） */
export const VERBATIM_WINDOW = 12;
/** 世界书关键词扫描范围（最近消息条数） */
export const KEYWORD_SCAN_WINDOW = 8;
/** 向量入库前截取的单块最大长度 */
const chunkSize = 400;

/* ------------------------------ 世界书命中 ------------------------------ */

/** 纯函数：在 texts 里做关键词匹配，按权重降序取前 maxHits 条 */
export function matchWorldbook(
  entries: WbEntry[],
  texts: string[],
  maxHits: number,
): WbEntry[] {
  const haystack = texts.join("\n").toLowerCase();
  const hits = entries.filter((e) => {
    if (!e.enabled) return false;
    return e.keywords.some((k) => k && haystack.includes(k.toLowerCase()));
  });
  hits.sort((a, b) => b.weight - a.weight || a.sort - b.sort);
  return hits.slice(0, maxHits);
}

/* ------------------------------ 数据读取层 ------------------------------ */

export function getCharacterCard(characterId: string): CharacterCard | null {
  const row = db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    identity: row.identity,
    speechStyle: row.speechStyle,
    values: row.values,
    boundaries: row.boundaries,
    userAddressing: row.userAddressing,
    relationship: row.relationship,
    firstMessage: row.firstMessage,
    examples: parseExamples(row.examplesJson),
    isTemplate: row.isTemplate === 1,
    ttsRefAudio: row.ttsRefAudio,
    ttsPromptText: row.ttsPromptText,
    ttsPromptLang: row.ttsPromptLang,
    ttsLang: row.ttsLang,
  };
}

export function getWorldbookEntriesForCharacter(
  characterId: string,
): { worldbookId: string; entries: WbEntry[] } {
  const wb = db
    .select()
    .from(worldbooks)
    .where(eq(worldbooks.characterId, characterId))
    .get();
  if (!wb) return { worldbookId: "", entries: [] };
  const rows = db
    .select()
    .from(wbEntries)
    .where(eq(wbEntries.worldbookId, wb.id))
    .all();
  const entries: WbEntry[] = rows.map((r) => ({
    id: r.id,
    worldbookId: r.worldbookId,
    category: r.category as WbEntry["category"],
    title: r.title,
    content: r.content,
    keywords: safeParseArray(r.keywordsJson),
    weight: r.weight,
    sort: r.sort,
    enabled: r.enabled === 1,
  }));
  return { worldbookId: wb.id, entries };
}

function safeParseArray(json: string): string[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/* ------------------------------ 滚动摘要层 ------------------------------ */

/** 发完一轮后调用：若未摘要的历史超过阈值，用轻量档压缩一次 */
export async function maybeUpdateSummary(conversationId: string) {
  const conv = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!conv) return;

  const all = db
    .select({ id: messagesTable.id, content: messagesTable.content })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .all();

  const s = getSettings();
  const toSummarizeCount = all.length - VERBATIM_WINDOW;
  if (toSummarizeCount <= conv.summarizedCount + s.summaryEveryTurns) return;

  const slice = all.slice(conv.summarizedCount, toSummarizeCount);
  if (slice.length === 0) return;

  const recentText = slice
    .map((m) => m.content)
    .join("\n")
    .slice(0, 4000);
  const cfg = modelFor(s, "light");
  try {
    const summary = await chatComplete(
      cfg,
      buildSummaryMessages(conv.summaryText, recentText),
      { kind: "summary", userText: conv.summaryText },
    );
    db.update(conversations)
      .set({
        summaryText: summary.trim(),
        summarizedCount: toSummarizeCount,
        updatedAt: Date.now(),
      })
      .where(eq(conversations.id, conversationId))
      .run();
  } catch (err) {
    // 摘要失败不阻塞对话，下轮会重试
    console.error("[memory] 摘要更新失败:", err);
  }
}

/* ------------------------------ 向量检索层 ------------------------------ */

/** 新消息入库后调用：切块并存 Embedding（未配置则静默跳过） */
export async function storeEmbedding(
  conversationId: string,
  messageId: string,
  content: string,
) {
  const s = getSettings();
  const vectors = await embedTexts(s.embed, [content.slice(0, chunkSize)]);
  if (!vectors || vectors.length === 0) return;
  db.insert(msgChunks)
    .values({
      id: crypto.randomUUID(),
      conversationId,
      messageId,
      chunk: content.slice(0, chunkSize),
      vectorJson: JSON.stringify(vectors[0]),
      createdAt: Date.now(),
    })
    .run();
}

/** 按语义检索更早的对话片段（排除 verbatim 窗口内的消息，避免重复注入） */
export async function searchVectorMemories(
  conversationId: string,
  query: string,
  excludeMessageIds: string[],
): Promise<{ chunk: string; score: number }[]> {
  const s = getSettings();
  if (!s.embed.baseUrl || !s.embed.model) return [];
  const queryVec = await embedTexts(s.embed, [query.slice(0, chunkSize)]);
  if (!queryVec) return [];

  const candidates = db
    .select()
    .from(msgChunks)
    .where(
      excludeMessageIds.length
        ? and(
            eq(msgChunks.conversationId, conversationId),
            notInArray(msgChunks.messageId, excludeMessageIds),
          )
        : eq(msgChunks.conversationId, conversationId),
    )
    .all();

  return candidates
    .map((c) => ({
      chunk: c.chunk,
      score: cosineSim(queryVec[0], safeParseVector(c.vectorJson)),
    }))
    .filter((m) => m.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, s.vecTopK);
}

function safeParseVector(json: string): number[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/* --------------------------- 会话消息窗口工具 --------------------------- */

export function getRecentMessages(conversationId: string, limit = VERBATIM_WINDOW) {
  const rows = db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .all();
  return rows.slice(-limit);
}

export function getMessagesSince(conversationId: string, count: number) {
  const rows = db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .all();
  return rows.slice(-count);
}

/** 供「世界书命中面板」等 UI 预览用 */
export function previewWorldbookHits(characterId: string, text: string, maxHits: number) {
  const { entries } = getWorldbookEntriesForCharacter(characterId);
  return matchWorldbook(entries, [text], maxHits);
}
