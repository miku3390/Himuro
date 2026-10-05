import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { characters, worldbooks } from "@/lib/db/schema";
import CharactersClient from "@/components/CharactersClient";

export const dynamic = "force-dynamic";

export default function CharactersPage() {
  const rows = db.select().from(characters).orderBy(desc(characters.updatedAt)).all();
  const wbs = db.select().from(worldbooks).all();
  const wbByChar = new Map(wbs.map((w) => [w.characterId, w.id]));

  const map = (c: (typeof rows)[number]) => ({
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
    examples: [],
    isTemplate: c.isTemplate === 1,
    worldbookId: wbByChar.get(c.id) ?? null,
  });

  return (
    <CharactersClient
      myCharacters={rows.filter((c) => c.isTemplate === 0).map(map)}
      templates={rows.filter((c) => c.isTemplate === 1).map(map)}
    />
  );
}
