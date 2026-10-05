import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, convMembers, messages as messagesTable } from "@/lib/db/schema";
import { getCharacterCard, getWorldbookEntriesForCharacter } from "@/lib/memory";
import type { CharacterCard, GroupStrategy, WbEntry } from "@/lib/types";

/**
 * 群聊辅助：成员管理 + 发言策略。
 *
 * 群聊的判定：会话存在 conv_members 行（≥2 个成员）。1:1 会话不写成员表。
 * 每个成员带自己的角色卡与世界书条目（命中注入按角色独立进行）。
 */

export type MemberCtx = {
  characterId: string;
  sort: number;
  card: CharacterCard;
  entries: WbEntry[];
};

export function getConversationMembers(conversationId: string): MemberCtx[] {
  const rows = db
    .select()
    .from(convMembers)
    .where(eq(convMembers.conversationId, conversationId))
    .all()
    .sort((a, b) => a.sort - b.sort);
  const out: MemberCtx[] = [];
  for (const r of rows) {
    const card = getCharacterCard(r.characterId);
    if (!card) continue; // 角色已被删除的成员自动跳过
    const { entries } = getWorldbookEntriesForCharacter(r.characterId);
    out.push({ characterId: r.characterId, sort: r.sort, card, entries });
  }
  return out;
}

/** 上一轮最后发言的成员（rotate 轮换的依据） */
export function lastSpeakerCharacterId(conversationId: string): string | null {
  const rows = db
    .select({ role: messagesTable.role, characterId: messagesTable.characterId, idx: messagesTable.idx })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .all();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === "assistant") return rows[i].characterId ?? null;
  }
  return null;
}

/**
 * 选出本轮要发言的成员（按发言顺序返回）。
 * - rerollSpeakerId 优先：重Roll 时固定为被替换回复的角色
 * - mention：用户消息里点到了名字的所有成员；没人被点名则轮换下一位
 * - rotate：上一位发言者的下一位（循环）
 * - all：全部成员按成员顺序
 */
export function selectSpeakers(
  strategy: GroupStrategy,
  members: MemberCtx[],
  content: string,
  lastSpeakerId: string | null,
  rerollSpeakerId?: string | null,
): MemberCtx[] {
  if (rerollSpeakerId) {
    const fixed = members.filter((m) => m.characterId === rerollSpeakerId);
    if (fixed.length) return fixed;
  }
  const nextInRotation = (): MemberCtx[] => {
    if (members.length === 0) return [];
    if (!lastSpeakerId) return [members[0]];
    const idx = members.findIndex((m) => m.characterId === lastSpeakerId);
    return [members[(idx + 1) % members.length]];
  };
  switch (strategy) {
    case "all":
      return members;
    case "rotate":
      return nextInRotation();
    case "mention":
    default: {
      // 全名或基础名（去掉「（副本）」这类后缀）被提到都算点名
      const named = members.filter((m) => {
        if (content.includes(m.card.name)) return true;
        const base = m.card.name.split("（")[0].trim();
        return base.length > 0 && content.includes(base);
      });
      return named.length ? named : nextInRotation();
    }
  }
}

/** 群聊会话的群策略读取（未建群返回 null） */
export async function getGroupStrategy(conversationId: string): Promise<GroupStrategy | null> {
  const row = db
    .select({ s: conversations.groupStrategy })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!row?.s) return null;
  return (["mention", "rotate", "all"].includes(row.s) ? row.s : "mention") as GroupStrategy;
}
