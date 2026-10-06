import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { characters, worldbooks } from "@/lib/db/schema";
import CharacterEditor from "@/components/CharacterEditor";
import { cardFromRow } from "@/lib/memory";

export const dynamic = "force-dynamic";

export default async function CharacterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const row = db.select().from(characters).where(eq(characters.id, id)).get();
  if (!row) notFound();
  const wb = db.select().from(worldbooks).where(eq(worldbooks.characterId, id)).get();
  const card = cardFromRow(row);

  return (
    <CharacterEditor
      initial={card}
      worldbookCharacterId={id}
      hasWorldbook={Boolean(wb)}
    />
  );
}
