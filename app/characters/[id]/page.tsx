import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { characters, worldbooks } from "@/lib/db/schema";
import CharacterEditor from "@/components/CharacterEditor";
import { parseExamples } from "@/lib/types";

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

  return (
    <CharacterEditor
      initial={{
        id: row.id,
        name: row.name,
        emoji: row.emoji,
        color: row.color,
        identity: row.identity,
        speechStyle: row.speechStyle,
        values: row.values,
        boundaries: row.boundaries,
        userAddressing: row.userAddressing,
        relationship: row.relationship,
        firstMessage: row.firstMessage,
        examples: parseExamples(row.examplesJson),
      }}
      worldbookCharacterId={id}
      hasWorldbook={Boolean(wb)}
    />
  );
}
