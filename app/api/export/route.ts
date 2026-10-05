import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { characters, conversations, messages as messagesTable } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * 对话导出（风月「复盘」工作流的第一步）。
 * GET /api/export?conversationId=xxx&format=txt|json
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId") ?? "";
  const format = url.searchParams.get("format") === "json" ? "json" : "txt";
  if (!conversationId) return Response.json({ error: "缺少 conversationId" }, { status: 400 });

  const conv = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!conv) return Response.json({ error: "会话不存在" }, { status: 404 });
  const card = db
    .select()
    .from(characters)
    .where(eq(characters.id, conv.characterId))
    .get();
  const rows = db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .all();
  const settings = getSettings();

  const roleLabel = (role: string) =>
    role === "user" ? "你" : card?.name ?? "角色";

  let payload: string;
  let filename: string;
  if (format === "json") {
    payload = JSON.stringify(
      {
        format: "himuro-chat",
        version: 1,
        conversation: {
          id: conv.id,
          title: conv.title,
          mode: conv.mode,
          tier: conv.tier,
          chapter: conv.chapter,
          summary: conv.summaryText,
        },
        character: card
          ? {
              name: card.name,
              identity: card.identity,
              speechStyle: card.speechStyle,
              values: card.values,
              boundaries: card.boundaries,
              userAddressing: card.userAddressing,
              relationship: card.relationship,
            }
          : null,
        model: conv.tier === "quality" ? settings.quality : settings.light,
        messages: rows.map((m) => ({
          role: m.role,
          content: m.content,
          emotion: m.emotion,
          starred: m.starred === 1,
          createdAt: m.createdAt,
        })),
      },
      null,
      2,
    );
    filename = `${conv.title}-${new Date().toISOString().slice(0, 10)}.json`;
  } else {
    const lines = [
      `# ${conv.title}`,
      `模式：${conv.mode === "story" ? "连载剧情" : "日常聊天"}｜档位：${conv.tier === "quality" ? "高质量" : "轻量"}｜第 ${conv.chapter} 章`,
      `导出时间：${new Date().toLocaleString("zh-CN")}`,
      "".padEnd(40, "-"),
      "",
      ...rows.map(
        (m) =>
          `${m.starred ? "★ " : ""}${roleLabel(m.role)}${m.emotion ? `（情绪目标：${m.emotion}）` : ""}：\n${m.content}\n`,
      ),
    ];
    payload = lines.join("\n");
    filename = `${conv.title}-${new Date().toISOString().slice(0, 10)}.txt`;
  }

  return new Response(payload, {
    headers: {
      "content-type": format === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
