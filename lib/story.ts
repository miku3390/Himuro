"use server";

import { db } from "@/lib/db";
import { conversations, convMembers, wbEntries } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { characters } from "@/lib/db/schema";
import {
  getMessagesSince,
  getWorldbookEntriesForCharacter,
} from "@/lib/memory";
import { buildDistillMessages, buildHookMessages } from "@/lib/prompt";
import { chatComplete } from "@/lib/llm";
import { getSettings, modelFor } from "@/lib/settings";
import type { WbCategory } from "@/lib/types";

/** 连载剧情专属 AI 任务：下一章钩子 / 状态回写世界书（先出草稿，用户确认后入库） */

/** 群聊感知的消息标签：assistant 消息署名发言人 */
function makeLabeler(conversationId: string) {
  const memberIds = db
    .select({ cid: convMembers.characterId })
    .from(convMembers)
    .where(eq(convMembers.conversationId, conversationId))
    .all();
  const nameById: Record<string, string> = {};
  for (const { cid } of memberIds) {
    const c = db.select({ name: characters.name }).from(characters).where(eq(characters.id, cid)).get();
    if (c) nameById[cid] = c.name;
  }
  return (m: { role: string; characterId: string | null }) =>
    m.role === "user" ? "用户" : m.characterId && nameById[m.characterId] ? nameById[m.characterId] : "角色";
}

/** 生成「下一章钩子」 */
export async function generateHook(conversationId: string): Promise<string> {
  const row = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!row) throw new Error("会话不存在");

  const label = makeLabeler(conversationId);
  const recent = getMessagesSince(conversationId, 20);
  const recentText = recent.map((m) => `${label(m)}：${m.content}`).join("\n");
  const s = getSettings();
  return chatComplete(
    modelFor(s, row.tier === "quality" ? "quality" : "light"),
    buildHookMessages(row.summaryText, recentText),
    { kind: "hook" },
  );
}

/** 从最近对话提炼「值得写进世界书」的条目草稿 */
export async function distillWorldbookDraft(
  conversationId: string,
): Promise<
  { category: WbCategory; title: string; content: string; keywords: string[]; weight: number }[]
> {
  const row = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!row) throw new Error("会话不存在");

  const label = makeLabeler(conversationId);
  const recent = getMessagesSince(conversationId, 20);
  const recentText = recent
    .map((m) => `${label(m)}：${m.content}`)
    .join("\n")
    .slice(0, 4000);

  const { worldbookId } = getWorldbookEntriesForCharacter(row.characterId);
  const existing = db
    .select({ title: wbEntries.title })
    .from(wbEntries)
    .where(eq(wbEntries.worldbookId, worldbookId))
    .all();

  const s = getSettings();
  const raw = await chatComplete(
    modelFor(s, "light"),
    buildDistillMessages(existing.map((e) => e.title), recentText),
    { kind: "distill" },
  );

  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 3).map((x) => ({
      category: (["人物", "地点", "事件", "规则"].includes(x?.category)
        ? x.category
        : "事件") as WbCategory,
      title: String(x?.title ?? "未命名").slice(0, 40),
      content: String(x?.content ?? "").slice(0, 200),
      keywords: Array.isArray(x?.keywords) ? x.keywords.map(String).slice(0, 6) : [],
      weight: Math.min(10, Math.max(1, Number(x?.weight) || 5)),
    }));
  } catch {
    return [];
  }
}
