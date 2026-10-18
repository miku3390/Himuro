// 独立跑一次 drizzle 迁移（正常情况下 npm run dev 启动时会自动迁移）。
// 给评测/种子脚本用：node scripts/migrate.mjs
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

fs.mkdirSync("data", { recursive: true });
const sqlite = new Database("data/himuro.db");
sqlite.pragma("journal_mode = WAL");
// 迁移器不需要 schema，空实例即可
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
console.log("√ 迁移已应用");
