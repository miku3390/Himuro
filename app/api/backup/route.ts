import { db } from "@/lib/db";
import {
  characters,
  conversations,
  convMembers,
  messages as messagesTable,
  msgChunks,
  settings as settingsTable,
  wbEntries,
  wbVersions,
  worldbooks,
} from "@/lib/db/schema";
import { revalidatePath } from "next/cache";

export const runtime = "nodejs";

/**
 * 全库备份/恢复（本地单用户，JSON 全量快照）。
 * GET  → himuro-backup JSON 附件（9 张表全量）
 * POST → 事务内清库重建（覆盖现有全部数据），按表回插，主键原样保留
 */

const TABLES = {
  characters,
  worldbooks,
  wbEntries,
  wbVersions,
  conversations,
  convMembers,
  messages: messagesTable,
  msgChunks,
  settings: settingsTable,
} as const;

type TableName = keyof typeof TABLES;

export async function GET() {
  const payload = {
    format: "himuro-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: Object.fromEntries(
      (Object.keys(TABLES) as TableName[]).map((name) => [name, db.select().from(TABLES[name]).all()]),
    ),
  };
  const filename = `himuro-backup-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    format?: string;
    version?: number;
    tables?: Record<string, unknown[]>;
  } | null;
  if (!body || body.format !== "himuro-backup" || !body.tables) {
    return Response.json({ error: "不是合法的 Himuro 备份文件" }, { status: 400 });
  }

  const counts: Partial<Record<TableName, number>> = {};
  try {
    db.transaction((tx) => {
      // 子表在前逐张清空
      for (const name of ["msgChunks", "messages", "convMembers", "conversations", "wbVersions", "wbEntries", "worldbooks", "characters", "settings"] as TableName[]) {
        tx.delete(TABLES[name]).run();
      }
      // 回插顺序无强约束（未开外键），按原顺序即可
      for (const name of Object.keys(TABLES) as TableName[]) {
        const rows = body.tables?.[name];
        if (!Array.isArray(rows) || rows.length === 0) {
          counts[name] = 0;
          continue;
        }
        tx.insert(TABLES[name])
          .values(rows as never)
          .run();
        counts[name] = rows.length;
      }
    });
  } catch (err) {
    return Response.json(
      { error: `恢复失败：${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }

  revalidatePath("/");
  revalidatePath("/characters");
  revalidatePath("/settings");
  return Response.json({ ok: true, counts });
}
