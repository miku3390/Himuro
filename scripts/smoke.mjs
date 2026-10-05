// 冒烟测试：建临时会话 → 调 /api/chat SSE → 校验事件流 → 清理
import Database from "better-sqlite3";

const db = new Database("data/himuro.db");
const char = db.prepare("SELECT * FROM characters WHERE name='小满'").get();
const convId = crypto.randomUUID();
const now = Date.now();
db.prepare(
  "INSERT INTO conversations (id, character_id, title, mode, tier, chapter, summary_text, summarized_count, created_at, updated_at) VALUES (?,?,?,?,?,1,'',0,?,?)",
).run(convId, char.id, "冒烟测试 · 日常", "daily", "light", now, now);

const res = await fetch("http://localhost:3000/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    conversationId: convId,
    content: "周六去海边看日出的事情还作数吗？",
    emotion: "安慰",
  }),
});
console.log("HTTP", res.status, res.headers.get("content-type"));

const text = await res.text();
const events = text
  .split("\n\n")
  .filter(Boolean)
  .map((b) => JSON.parse(b.trim().slice(5)));
const kinds = events.map((e) => e.t);
const tokens = events
  .filter((e) => e.t === "tok")
  .map((e) => e.v)
  .join("");
console.log("事件序列:", [...new Set(kinds)].join(" → "));
console.log("hits:", JSON.stringify(events.find((e) => e.t === "hits")?.hits));
console.log("回复全文:", tokens.slice(0, 120).replace(/\n/g, " "));
console.log("done 事件:", JSON.stringify(events.find((e) => e.t === "done")));

const msgCount = db
  .prepare("SELECT count(*) n FROM messages WHERE conversation_id=?")
  .get(convId).n;
console.log("落库消息数(应为3: 开场白+用户+回复):", msgCount);

db.prepare("DELETE FROM messages WHERE conversation_id=?").run(convId);
db.prepare("DELETE FROM conversations WHERE id=?").run(convId);
console.log("临时会话已清理");
