import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  conversations,
  messages as messagesTable,
} from "@/lib/db/schema";

/**
 * 对话分支树（v1.5）：
 * - 每条消息带 parentId（null = 根）与 activeChildId（活跃子分支，null = 取 idx 最大的孩子）
 * - 会话带 activeRootId（活跃根，null = 取 idx 最小的根）
 * - 群聊一轮的多个发言者按发言顺序链式挂接（B 的父是 A，不是用户消息），
 *   因此「从根沿单一活跃孩子走到叶子」就是当前可见的对话路径
 * - 重Roll / 编辑重发 = 新建兄弟分支；旧分支保留，可随时切回
 */

export type MsgRow = typeof messagesTable.$inferSelect;
export type MsgRowWithAlt = MsgRow & { altIndex: number; altCount: number };

export function getAllMessages(conversationId: string): MsgRow[] {
  return db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .all();
}

/** 单根选取：activeRootId 有效则用之，否则取 idx 最小的根 */
function pickRoot(rows: MsgRow[], activeRootId: string | null | undefined): MsgRow | undefined {
  const roots = rows.filter((r) => !r.parentId).sort((a, b) => a.idx - b.idx);
  if (roots.length === 0) return undefined;
  return roots.find((r) => r.id === activeRootId) ?? roots[0];
}

/** 在内存消息集合里走活跃路径（纯函数，便于测试） */
export function activePathOf(rows: MsgRow[], activeRootId?: string | null): MsgRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, MsgRow[]>();
  for (const r of rows) {
    // 悬空 parent（指向已被删除的消息）按根处理
    const key = r.parentId && byId.has(r.parentId) ? r.parentId : null;
    if (key === null) continue;
    const list = children.get(key) ?? [];
    list.push(r);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.idx - b.idx);

  const path: MsgRow[] = [];
  const visited = new Set<string>();
  let node = pickRoot(rows, activeRootId);
  while (node && !visited.has(node.id)) {
    visited.add(node.id);
    path.push(node);
    const kids = children.get(node.id) ?? [];
    if (kids.length === 0) break;
    const active = node.activeChildId ? byId.get(node.activeChildId) : undefined;
    // 活跃孩子失效（不存在/不是自己的孩子）时回落 idx 最大的孩子
    node = active && kids.some((k) => k.id === active.id) ? active : kids[kids.length - 1];
  }
  return path;
}

/** 活跃路径（根 → 叶子） */
export function getActivePath(conversationId: string): MsgRow[] {
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  return activePathOf(getAllMessages(conversationId), conv?.activeRootId);
}

/** 兄弟组 key：assistant 按 parentId+characterId 分组（群聊同轮其他发言者不是备选），user 按 parentId */
export function altKeyOf(m: Pick<MsgRow, "role" | "parentId" | "characterId">): string {
  return m.role === "assistant"
    ? `${m.parentId ?? "-"}|a|${m.characterId ?? "-"}`
    : `${m.parentId ?? "-"}|u`;
}

/** 消息的兄弟备选组（按 idx 排序，含自身） */
export function alternativesOf(m: MsgRow, allRows: MsgRow[]): MsgRow[] {
  const k = altKeyOf(m);
  return allRows
    .filter((r) => altKeyOf(r) === k)
    .sort((a, b) => a.idx - b.idx);
}

/** 给路径上每条消息算 ‹ i/n › 信息 */
export function withAltInfo(path: MsgRow[], allRows: MsgRow[]): MsgRowWithAlt[] {
  return path.map((m) => {
    const group = alternativesOf(m, allRows);
    const i = group.findIndex((x) => x.id === m.id);
    return { ...m, altIndex: i + 1, altCount: group.length };
  });
}

/** 子树消息 id（含自身），用于级联删除 */
export function subtreeIds(rootId: string, allRows: MsgRow[]): string[] {
  const children = new Map<string, string[]>();
  for (const r of allRows) {
    if (!r.parentId) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r.id);
    children.set(r.parentId, list);
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.includes(id)) continue;
    out.push(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

/** 会话内新消息的 idx：单调递增的插入序号（分支后不再等于显示顺序，仅作排序/兼容用） */
export function nextIdx(conversationId: string): number {
  return getAllMessages(conversationId).length;
}
