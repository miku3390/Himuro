import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { characters, conversations, convMembers, messages as messagesTable } from "@/lib/db/schema";
import ChatRoom from "@/components/ChatRoom";
import { getCharacterCard } from "@/lib/memory";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!conv) notFound();

  // 群聊成员（≥2 即群聊）；再加历史上出现过发言的成员（被移出群聊的角色的旧消息仍需署名）
  const memberRows = db
    .select()
    .from(convMembers)
    .where(eq(convMembers.conversationId, id))
    .all()
    .sort((a, b) => a.sort - b.sort);
  const isGroup = memberRows.length >= 2;
  const msgRows = db
    .select({ characterId: messagesTable.characterId })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .all();
  const involvedIds = Array.from(
    new Set<string>([
      ...memberRows.map((m) => m.characterId),
      ...(isGroup ? msgRows.map((m) => m.characterId).filter((x): x is string => Boolean(x)) : []),
      conv.characterId,
    ]),
  );
  const charRows = involvedIds
    .map((cid) => db.select().from(characters).where(eq(characters.id, cid)).get())
    .filter((c) => Boolean(c))
    .map((c) => ({ id: c!.id, name: c!.name, emoji: c!.emoji, color: c!.color }));

  // 页头主角色：单聊 = 会话角色；群聊 = 第一个成员（或会话角色兜底）
  const primaryId = isGroup ? (memberRows[0]?.characterId ?? conv.characterId) : conv.characterId;
  const character = getCharacterCard(primaryId);
  if (!character) notFound();

  const rows = db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .all();

  // 「添加成员」下拉的候选 = 全部非模板角色
  const allMine = db
    .select({ id: characters.id, name: characters.name, emoji: characters.emoji, color: characters.color })
    .from(characters)
    .where(eq(characters.isTemplate, 0))
    .all();

  return (
    <ChatRoom
      conversation={{
        id: conv.id,
        title: conv.title,
        mode: conv.mode as "daily" | "story",
        tier: conv.tier as "light" | "quality",
        chapter: conv.chapter,
        summary: conv.summaryText,
        groupStrategy: (conv.groupStrategy as "mention" | "rotate" | "all" | null) ?? null,
      }}
      character={character}
      members={charRows}
      isGroup={isGroup}
      allCharacters={allMine}
      initialMessages={rows.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        characterId: m.characterId,
        emotion: m.emotion,
        starred: m.starred === 1,
      }))}
    />
  );
}
