import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { characters, wbEntries, wbVersions, worldbooks } from "@/lib/db/schema";
import WorldbookManager from "@/components/WorldbookManager";
import type { WbCategory } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function WorldbookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // 路由按角色 ID（每个角色一本世界书，1:1）
  const { id: characterId } = await params;
  const character = db.select().from(characters).where(eq(characters.id, characterId)).get();
  if (!character) notFound();

  const wb = db.select().from(worldbooks).where(eq(worldbooks.characterId, characterId)).get();
  // 世界书通常随角色一起创建；万一缺失，由页面上「创建世界书」按钮的 action 补建

  const entries = wb
    ? db
        .select()
        .from(wbEntries)
        .where(eq(wbEntries.worldbookId, wb.id))
        .all()
        .sort((a, b) => b.weight - a.weight || a.sort - b.sort)
        .map((e) => ({
          id: e.id,
          worldbookId: e.worldbookId,
          category: e.category as WbCategory,
          title: e.title,
          content: e.content,
          keywords: JSON.parse(e.keywordsJson) as string[],
          weight: e.weight,
          sort: e.sort,
          enabled: e.enabled === 1,
        }))
    : [];

  const versions = wb
    ? db
        .select({ id: wbVersions.id, note: wbVersions.note, createdAt: wbVersions.createdAt })
        .from(wbVersions)
        .where(eq(wbVersions.worldbookId, wb.id))
        .all()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 30)
    : [];

  return (
    <WorldbookManager
      character={{ id: character.id, name: character.name, emoji: character.emoji }}
      worldbook={wb ? { id: wb.id, name: wb.name } : null}
      entries={entries}
      versions={versions}
    />
  );
}
