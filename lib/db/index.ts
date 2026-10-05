import "server-only";
import path from "node:path";
import fs from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";

import * as schema from "./schema";
import { seedIfEmpty } from "./seed";

/**
 * SQLite 连接（单例）。
 * - 库文件固定在项目根 data/himuro.db，首次运行自动建目录
 * - 首次访问自动跑 drizzle 迁移 + 种子数据，无需任何手动初始化
 * - dev 热重载会反复 import 本模块，用 globalThis 缓存连接
 */
const DB_PATH = path.join(process.cwd(), "data", "himuro.db");

declare global {
  var __himuroDb__: ReturnType<typeof createDb> | undefined;
}
function createDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  seedIfEmpty(db);
  return db;
}

export function getDb() {
  if (!globalThis.__himuroDb__) {
    globalThis.__himuroDb__ = createDb();
  }
  return globalThis.__himuroDb__;
}

export { schema };
export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_t, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
