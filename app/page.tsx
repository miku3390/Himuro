import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { characters, conversations } from "@/lib/db/schema";
import HomeClient from "@/components/HomeClient";
import { parseExamples } from "@/lib/types";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const allChars = db.select().from(characters).orderBy(desc(characters.updatedAt)).all();
  const convRows = db
    .select({
      id: conversations.id,
      title: conversations.title,
      mode: conversations.mode,
      tier: conversations.tier,
      chapter: conversations.chapter,
      groupStrategy: conversations.groupStrategy,
      updatedAt: conversations.updatedAt,
      characterName: characters.name,
      characterEmoji: characters.emoji,
      characterColor: characters.color,
    })
    .from(conversations)
    .leftJoin(characters, eq(conversations.characterId, characters.id))
    .orderBy(desc(conversations.updatedAt))
    .all();

  const mapCard = (c: (typeof allChars)[number]) => ({
    id: c.id,
    name: c.name,
    emoji: c.emoji,
    color: c.color,
    identity: c.identity,
    speechStyle: c.speechStyle,
    values: c.values,
    boundaries: c.boundaries,
    userAddressing: c.userAddressing,
    relationship: c.relationship,
    firstMessage: c.firstMessage,
    examples: parseExamples(c.examplesJson),
    isTemplate: c.isTemplate === 1,
    hasWorldbook: true,
    ttsRefAudio: c.ttsRefAudio,
    ttsPromptText: c.ttsPromptText,
    ttsPromptLang: c.ttsPromptLang,
    ttsLang: c.ttsLang,
  });

  return (
    <HomeClient
      conversations={convRows.map((r) => ({
        ...r,
        characterName: r.characterName ?? "（已删除角色）",
        characterEmoji: r.characterEmoji ?? "❓",
        characterColor: r.characterColor ?? "#a1a1aa",
      }))}
      myCharacters={allChars.filter((c) => c.isTemplate === 0).map(mapCard)}
      templates={allChars.filter((c) => c.isTemplate === 1).map(mapCard)}
    />
  );
}
