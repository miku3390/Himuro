"use server";

import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  characters,
  conversations,
  convMembers,
  messages as messagesTable,
  wbEntries,
  wbVersions,
  worldbooks,
} from "@/lib/db/schema";
import {
  alternativesOf,
  altKeyOf,
  getAllMessages,
  nextIdx,
  subtreeIds,
} from "@/lib/branch";
import { saveSettings, getSettings } from "@/lib/settings";
import {
  parseExamples,
  type CharacterCard,
  type Example,
  type GroupStrategy,
  type Mode,
  type Tier,
  type WbCategory,
} from "@/lib/types";

/**
 * 全部服务端 Actions（角色卡 / 世界书 / 会话 / 消息 / 设置）。
 * 页面通过 `import { xxx } from "@/lib/actions"` 直接调用。
 */

const now = () => Date.now();
const uid = () => crypto.randomUUID();

/* ================================ 角色卡 ================================ */

export type CharacterInput = Omit<
  CharacterCard,
  "id" | "isTemplate" | "examples"
> & { examples: Example[] };

function upsertCharacterValues(input: CharacterInput) {
  return {
    name: input.name.trim() || "未命名角色",
    emoji: input.emoji || "🙂",
    color: input.color || "#6366f1",
    identity: input.identity,
    speechStyle: input.speechStyle,
    values: input.values,
    boundaries: input.boundaries,
    userAddressing: input.userAddressing,
    relationship: input.relationship,
    firstMessage: input.firstMessage,
    examplesJson: JSON.stringify(input.examples.slice(0, 5)),
    ttsRefAudio: input.ttsRefAudio ?? "",
    ttsPromptText: input.ttsPromptText ?? "",
    ttsPromptLang: input.ttsPromptLang ?? "",
    ttsLang: input.ttsLang ?? "",
  };
}

/** 新建角色（可选同时建世界书） */
export async function createCharacter(
  input: CharacterInput,
  withWorldbook: boolean,
): Promise<{ id: string }> {
  const id = uid();
  db.insert(characters)
    .values({ id, ...upsertCharacterValues(input), isTemplate: 0, createdAt: now(), updatedAt: now() })
    .run();
  if (withWorldbook) {
    db.insert(worldbooks)
      .values({ id: uid(), characterId: id, name: `${input.name}的世界书`, createdAt: now() })
      .run();
  }
  revalidatePath("/characters");
  return { id };
}

export async function updateCharacter(id: string, input: CharacterInput) {
  db.update(characters)
    .set({ ...upsertCharacterValues(input), updatedAt: now() })
    .where(eq(characters.id, id))
    .run();
  revalidatePath("/characters");
  revalidatePath(`/characters/${id}`);
}

export async function deleteCharacter(id: string) {
  db.delete(characters).where(eq(characters.id, id)).run();
  // 级联清理（SQLite 未开外键，手动删）
  const wbs = db.select().from(worldbooks).where(eq(worldbooks.characterId, id)).all();
  for (const wb of wbs) {
    db.delete(wbEntries).where(eq(wbEntries.worldbookId, wb.id)).run();
    db.delete(wbVersions).where(eq(wbVersions.worldbookId, wb.id)).run();
  }
  db.delete(worldbooks).where(eq(worldbooks.characterId, id)).run();
  const convs = db.select().from(conversations).where(eq(conversations.characterId, id)).all();
  for (const c of convs) {
    db.delete(messagesTable).where(eq(messagesTable.conversationId, c.id)).run();
  }
  db.delete(conversations).where(eq(conversations.characterId, id)).run();
  revalidatePath("/characters");
}

/** 把模板角色复制为一张可编辑的新卡（含世界书与条目） */
export async function duplicateCharacter(id: string): Promise<{ id: string }> {
  const src = db.select().from(characters).where(eq(characters.id, id)).get();
  if (!src) throw new Error("角色不存在");
  const newId = uid();
  db.insert(characters)
    .values({
      ...src,
      id: newId,
      name: `${src.name}（副本）`,
      isTemplate: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  const srcWb = db.select().from(worldbooks).where(eq(worldbooks.characterId, id)).get();
  if (srcWb) {
    const newWbId = uid();
    db.insert(worldbooks)
      .values({ id: newWbId, characterId: newId, name: srcWb.name, createdAt: now() })
      .run();
    const entries = db.select().from(wbEntries).where(eq(wbEntries.worldbookId, srcWb.id)).all();
    for (const e of entries) {
      db.insert(wbEntries)
        .values({ ...e, id: uid(), worldbookId: newWbId, createdAt: now(), updatedAt: now() })
        .run();
    }
  }
  revalidatePath("/characters");
  return { id: newId };
}

/* ================================ 世界书 ================================ */

/** 命中预览（世界书管理页调试用）：给定文本，看会命中哪些条目 */
export async function previewWorldbookHitsAction(characterId: string, text: string) {
  const { previewWorldbookHits } = await import("@/lib/memory");
  const s = getSettings();
  const hits = previewWorldbookHits(characterId, text, s.wbMaxHits);
  return hits.map((h) => ({ category: h.category, title: h.title, weight: h.weight }));
}

/** 聊天页快捷保存：按角色找到其世界书（没有则建）直接写条目 */
export async function saveEntryForCharacter(characterId: string, input: WbEntryInput) {
  const wb = await ensureWorldbook(characterId);
  await saveEntry(wb.id, input);
}

/** 确保角色有世界书，返回它（世界书页兜底用） */
export async function ensureWorldbook(characterId: string) {
  const existing = db.select().from(worldbooks).where(eq(worldbooks.characterId, characterId)).get();
  if (existing) return existing;
  const card = db.select().from(characters).where(eq(characters.id, characterId)).get();
  const id = crypto.randomUUID();
  db.insert(worldbooks)
    .values({ id, characterId, name: `${card?.name ?? "角色"}的世界书`, createdAt: now() })
    .run();
  revalidatePath(`/worldbooks/${characterId}`);
  return db.select().from(worldbooks).where(eq(worldbooks.id, id)).get()!;
}

export type WbEntryInput = {
  id?: string;
  category: WbCategory;
  title: string;
  content: string;
  keywords: string[];
  weight: number;
  sort: number;
  enabled: boolean;
};

function snapshotWorldbook(worldbookId: string, note: string) {
  const entries = db
    .select()
    .from(wbEntries)
    .where(eq(wbEntries.worldbookId, worldbookId))
    .all();
  db.insert(wbVersions)
    .values({
      id: uid(),
      worldbookId,
      note,
      snapshotJson: JSON.stringify(entries),
      createdAt: now(),
    })
    .run();
  // 只保留最近 30 个版本
  const versions = db
    .select()
    .from(wbVersions)
    .where(eq(wbVersions.worldbookId, worldbookId))
    .all();
  if (versions.length > 30) {
    const del = versions
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, versions.length - 30);
    for (const v of del) db.delete(wbVersions).where(eq(wbVersions.id, v.id)).run();
  }
}

/** 新建/更新条目；变更前自动做整本快照（可回滚） */
export async function saveEntry(worldbookId: string, input: WbEntryInput) {
  const before = db
    .select({ title: wbEntries.title })
    .from(wbEntries)
    .where(eq(wbEntries.id, input.id ?? "__none__"))
    .get();
  snapshotWorldbook(worldbookId, before ? `修改条目「${before.title}」前` : "新增条目前");

  if (input.id) {
    db.update(wbEntries)
      .set({
        category: input.category,
        title: input.title,
        content: input.content,
        keywordsJson: JSON.stringify(input.keywords),
        weight: input.weight,
        sort: input.sort,
        enabled: input.enabled ? 1 : 0,
        updatedAt: now(),
      })
      .where(eq(wbEntries.id, input.id))
      .run();
  } else {
    db.insert(wbEntries)
      .values({
        id: uid(),
        worldbookId,
        category: input.category,
        title: input.title,
        content: input.content,
        keywordsJson: JSON.stringify(input.keywords),
        weight: input.weight,
        sort: input.sort,
        enabled: input.enabled ? 1 : 0,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }
  revalidatePath(`/worldbooks/${worldbookId}`);
}

export async function deleteEntry(worldbookId: string, entryId: string) {
  const row = db.select({ title: wbEntries.title }).from(wbEntries).where(eq(wbEntries.id, entryId)).get();
  snapshotWorldbook(worldbookId, `删除条目「${row?.title ?? entryId}」前`);
  db.delete(wbEntries).where(eq(wbEntries.id, entryId)).run();
  revalidatePath(`/worldbooks/${worldbookId}`);
}

/** 回滚到某个版本快照（回滚动作本身也会先存一份快照） */
export async function rollbackWorldbook(worldbookId: string, versionId: string) {
  const v = db.select().from(wbVersions).where(eq(wbVersions.id, versionId)).get();
  if (!v) throw new Error("版本不存在");
  snapshotWorldbook(worldbookId, `回滚前（自动保存）`);
  const snapshot = JSON.parse(v.snapshotJson) as (typeof wbEntries.$inferSelect)[];
  db.delete(wbEntries).where(eq(wbEntries.worldbookId, worldbookId)).run();
  for (const e of snapshot) {
    db.insert(wbEntries)
      .values({ ...e, createdAt: now(), updatedAt: now() })
      .run();
  }
  revalidatePath(`/worldbooks/${worldbookId}`);
}

/* ================================ 会话 ================================ */

export async function createConversation(
  characterId: string,
  mode: Mode,
): Promise<{ id: string }> {
  const card = db.select().from(characters).where(eq(characters.id, characterId)).get();
  if (!card) throw new Error("角色不存在");

  const id = uid();
  const modeLabel = mode === "story" ? "连载" : "日常";
  db.insert(conversations)
    .values({
      id,
      characterId,
      title: `${card.name} · ${modeLabel}`,
      mode,
      tier: "light",
      chapter: 1,
      summaryText: "",
      summarizedCount: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  // 开场白作为第一条角色消息
  if (card.firstMessage?.trim()) {
    db.insert(messagesTable)
      .values({
        id: uid(),
        conversationId: id,
        idx: 0,
        role: "assistant",
        content: card.firstMessage,
        createdAt: now(),
      })
      .run();
  }
  revalidatePath("/");
  return { id };
}

export async function updateConversation(
  id: string,
  patch: { mode?: Mode; tier?: Tier; title?: string; chapter?: number; groupStrategy?: GroupStrategy | null },
) {
  // 默认标题跟随模式（「XX · 日常/连载」），用户改过标题则保持不动
  if (patch.mode) {
    const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (conv && (conv.title.endsWith(" · 日常") || conv.title.endsWith(" · 连载"))) {
      const card = db
        .select({ name: characters.name })
        .from(characters)
        .where(eq(characters.id, conv.characterId))
        .get();
      if (card) patch = { ...patch, title: `${card.name} · ${patch.mode === "story" ? "连载" : "日常"}` };
    }
  }
  db.update(conversations)
    .set({ ...patch, updatedAt: now() })
    .where(eq(conversations.id, id))
    .run();
  revalidatePath("/");
  revalidatePath(`/chat/${id}`);
}

export async function deleteConversation(id: string) {
  db.delete(messagesTable).where(eq(messagesTable.conversationId, id)).run();
  db.delete(convMembers).where(eq(convMembers.conversationId, id)).run();
  db.delete(conversations).where(eq(conversations.id, id)).run();
  revalidatePath("/");
}

/* ================================ 群聊 ================================ */

/** 建群聊会话：至少 2 个成员；角色开场白不注入（群聊由用户先开口） */
export async function createGroupConversation(
  characterIds: string[],
  strategy: GroupStrategy,
): Promise<{ id: string }> {
  const unique = [...new Set(characterIds)];
  if (unique.length < 2) throw new Error("群聊至少需要 2 个角色");
  const cards = unique
    .map((id) => db.select().from(characters).where(eq(characters.id, id)).get())
    .filter(Boolean) as (typeof characters.$inferSelect)[];
  if (cards.length < 2) throw new Error("部分角色不存在");

  const id = uid();
  db.insert(conversations)
    .values({
      id,
      characterId: cards[0].id, // 主角色 = 第一个成员（页头展示用）
      title: `群聊 · ${cards.map((c) => c.name).slice(0, 3).join("、")}${cards.length > 3 ? "等" : ""}`,
      mode: "daily",
      tier: "light",
      chapter: 1,
      summaryText: "",
      summarizedCount: 0,
      groupStrategy: strategy,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  cards.forEach((c, i) => {
    db.insert(convMembers)
      .values({
        id: uid(),
        conversationId: id,
        characterId: c.id,
        sort: i,
        joinedAt: now(),
      })
      .run();
  });

  revalidatePath("/");
  return { id };
}

export async function addConversationMember(conversationId: string, characterId: string) {
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv) throw new Error("会话不存在");
  const card = db.select().from(characters).where(eq(characters.id, characterId)).get();
  if (!card) throw new Error("角色不存在");
  const existing = db
    .select()
    .from(convMembers)
    .where(eq(convMembers.conversationId, conversationId))
    .all();
  if (existing.some((m) => m.characterId === characterId)) return;
  db.insert(convMembers)
    .values({
      id: uid(),
      conversationId,
      characterId,
      sort: existing.length,
      joinedAt: now(),
    })
    .run();
  // 从 1 人（异常态）恢复成 2 人时，补上群策略
  if (!conv.groupStrategy) {
    db.update(conversations)
      .set({ groupStrategy: "mention", updatedAt: now() })
      .where(eq(conversations.id, conversationId))
      .run();
  }
  revalidatePath(`/chat/${conversationId}`);
}

export async function removeConversationMember(conversationId: string, characterId: string) {
  const rows = db
    .select()
    .from(convMembers)
    .where(eq(convMembers.conversationId, conversationId))
    .all();
  const target = rows.find((m) => m.characterId === characterId);
  if (!target) return;
  db.delete(convMembers).where(eq(convMembers.id, target.id)).run();
  // 群聊只剩 1 人时保留成员行（仍按群聊渲染历史），但策略退化为 mention——
  // 由「群聊=成员≥2」的判定自然回落到单聊流程
  revalidatePath(`/chat/${conversationId}`);
}

/* ================================ 消息 ================================ */

export async function toggleStar(messageId: string) {
  const m = db.select().from(messagesTable).where(eq(messagesTable.id, messageId)).get();
  if (!m) return;
  db.update(messagesTable)
    .set({ starred: m.starred === 1 ? 0 : 1 })
    .where(eq(messagesTable.id, messageId))
    .run();
}

/**
 * 删除消息及其整个子树（含向量块）。
 * 若父消息/会话的活跃分支指针指向被删节点，则回落到幸存兄弟（或置空走默认）。
 */
export async function deleteMessageTree(messageId: string) {
  const m = db.select().from(messagesTable).where(eq(messagesTable.id, messageId)).get();
  if (!m) return;
  const { msgChunks } = await import("@/lib/db/schema");
  const allRows = getAllMessages(m.conversationId);
  const ids = subtreeIds(messageId, allRows);
  const idSet = new Set(ids);
  for (const id of ids) db.delete(msgChunks).where(eq(msgChunks.messageId, id)).run();
  db.delete(messagesTable).where(inArray(messagesTable.id, ids)).run();

  if (m.parentId) {
    const parent = db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, m.parentId))
      .get();
    // 子树外的消息只有 parent 的活跃指针可能指进被删集合（且只能指向 m 自己）
    if (parent?.activeChildId && idSet.has(parent.activeChildId)) {
      const survivors = allRows
        .filter((r) => !idSet.has(r.id) && altKeyOf(r) === altKeyOf(m))
        .sort((a, b) => a.idx - b.idx);
      const fallback = survivors.at(-1);
      db.update(messagesTable)
        .set({ activeChildId: fallback?.id ?? null })
        .where(eq(messagesTable.id, parent.id))
        .run();
    }
  } else {
    const conv = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, m.conversationId))
      .get();
    if (conv?.activeRootId && idSet.has(conv.activeRootId)) {
      db.update(conversations).set({ activeRootId: null }).where(eq(conversations.id, conv.id)).run();
    }
  }
  revalidatePath(`/chat/${m.conversationId}`);
}

/**
 * 编辑用户消息 → 新建兄弟分支（v1.5 分支树：旧分支连同其后的回复原样保留）。
 * 返回新用户消息 id，客户端随后发起续写生成新回复。
 */
export async function editUserMessageBranch(
  messageId: string,
  newContent: string,
): Promise<{ conversationId: string; newUserMessageId: string }> {
  const m = db.select().from(messagesTable).where(eq(messagesTable.id, messageId)).get();
  if (!m) throw new Error("消息不存在");
  if (m.role !== "user") throw new Error("只能编辑用户消息");
  const content = newContent.trim();
  if (!content) throw new Error("内容不能为空");

  const newUserMessageId = uid();
  db.insert(messagesTable)
    .values({
      id: newUserMessageId,
      conversationId: m.conversationId,
      idx: nextIdx(m.conversationId),
      role: "user",
      content,
      characterId: null,
      parentId: m.parentId,
      emotion: m.emotion,
      createdAt: now(),
    })
    .run();
  if (m.parentId) {
    db.update(messagesTable)
      .set({ activeChildId: newUserMessageId })
      .where(eq(messagesTable.id, m.parentId))
      .run();
  } else {
    // 根级用户消息（无开场白的会话首条）→ 更新会话的活跃根
    db.update(conversations)
      .set({ activeRootId: newUserMessageId })
      .where(eq(conversations.id, m.conversationId))
      .run();
  }
  db.update(conversations)
    .set({ updatedAt: now() })
    .where(eq(conversations.id, m.conversationId))
    .run();
  revalidatePath(`/chat/${m.conversationId}`);
  return { conversationId: m.conversationId, newUserMessageId };
}

/** 分支切换：在兄弟备选组里移动 delta 步，把父消息（或会话）的活跃指针指过去 */
export async function switchAlternative(messageId: string, delta: number) {
  const m = db.select().from(messagesTable).where(eq(messagesTable.id, messageId)).get();
  if (!m) return;
  const group = alternativesOf(m, getAllMessages(m.conversationId));
  if (group.length < 2) return;
  const i = group.findIndex((x) => x.id === m.id);
  const next = group[(i + delta + group.length) % group.length] ?? m;
  if (next.id === m.id) return;
  if (m.parentId) {
    db.update(messagesTable)
      .set({ activeChildId: next.id })
      .where(eq(messagesTable.id, m.parentId))
      .run();
  } else {
    db.update(conversations)
      .set({ activeRootId: next.id, updatedAt: now() })
      .where(eq(conversations.id, m.conversationId))
      .run();
  }
  revalidatePath(`/chat/${m.conversationId}`);
}

/** 复盘回写：把某条满意回复 + 它前面的用户输入，存进角色卡示例对话（群聊时写入发言人自己的卡） */
export async function writeBackExample(messageId: string) {
  const m = db.select().from(messagesTable).where(eq(messagesTable.id, messageId)).get();
  if (!m || m.role !== "assistant") throw new Error("只能回写角色回复");

  // 分支树：沿父链向上找最近的用户输入（群聊同轮多个发言者共享同一条用户消息）
  let prevUserContent: string | null = null;
  let cursor: typeof m | undefined = m;
  while (cursor?.parentId) {
    const p = db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, cursor.parentId))
      .get();
    if (!p) break;
    if (p.role === "user") {
      prevUserContent = p.content;
      break;
    }
    cursor = p;
  }

  const conv = db.select().from(conversations).where(eq(conversations.id, m.conversationId)).get();
  if (!conv) throw new Error("会话不存在");
  const targetCharacterId = m.characterId ?? conv.characterId;
  const card = db.select().from(characters).where(eq(characters.id, targetCharacterId)).get();
  if (!card) throw new Error("角色不存在");

  const examples = parseExamples(card.examplesJson);
  examples.push({
    user: prevUserContent ?? "（用户未发言）",
    assistant: m.content,
  });
  if (examples.length > 5) examples.shift(); // 风月口径：3-5 组
  db.update(characters)
    .set({ examplesJson: JSON.stringify(examples), updatedAt: now() })
    .where(eq(characters.id, card.id))
    .run();
  revalidatePath(`/characters/${card.id}`);
}

/* ================================ 设置 ================================ */

export async function saveSettingsAction(patch: Parameters<typeof saveSettings>[0]) {
  saveSettings(patch);
  revalidatePath("/settings");
}

/* ============================ TTS 语音缓存 ============================ */

export async function ttsCacheInfoAction(): Promise<{ files: number; bytes: number }> {
  const { ttsCacheStats } = await import("@/lib/ttsCache");
  return ttsCacheStats();
}

export async function clearTtsCacheAction() {
  const { ttsCacheClear } = await import("@/lib/ttsCache");
  ttsCacheClear();
  revalidatePath("/settings");
}

/** 供设置页「测试连接」用：发一句 ping，返回首句或错误 */
export async function testModelConfig(
  tier: "light" | "quality",
): Promise<{ ok: boolean; reply: string }> {
  const s = getSettings();
  const cfg = s[tier];
  try {
    const { chatComplete } = await import("@/lib/llm");
    const reply = await chatComplete(
      cfg,
      [
        { role: "system", content: "你是连接测试器，只回复四个字：连接正常" },
        { role: "user", content: "ping" },
      ],
      { kind: "chat", characterName: "测试", userText: "ping" },
    );
    return { ok: true, reply: reply.slice(0, 50) };
  } catch (err) {
    return { ok: false, reply: err instanceof Error ? err.message : String(err) };
  }
}
