import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages as messagesTable } from "@/lib/db/schema";
import ChatRoom from "@/components/ChatRoom";
import { getCharacterCard } from "@/lib/memory";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!conv) notFound();
  const character = getCharacterCard(conv.characterId);
  if (!character) notFound();

  const rows = db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
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
      }}
      character={character}
      initialMessages={rows.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        emotion: m.emotion,
        starred: m.starred === 1,
      }))}
    />
  );
}
