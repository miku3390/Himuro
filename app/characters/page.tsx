import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { characters, worldbooks } from "@/lib/db/schema";
import CharactersClient from "@/components/CharactersClient";
import { cardFromRow } from "@/lib/memory";

export const dynamic = "force-dynamic";

export default function CharactersPage() {
  const rows = db.select().from(characters).orderBy(desc(characters.updatedAt)).all();
  const wbs = db.select().from(worldbooks).all();
  const wbByChar = new Map(wbs.map((w) => [w.characterId, w.id]));

  const map = (c: (typeof rows)[number]) => ({
    ...cardFromRow(c),
    worldbookId: wbByChar.get(c.id) ?? null,
  });

  return (
    <CharactersClient
      myCharacters={rows.filter((c) => c.isTemplate === 0).map(map)}
      templates={rows.filter((c) => c.isTemplate === 1).map(map)}
    />
  );
}
