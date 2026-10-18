// 把 lib/personas/kurisu.json 里的红莉栖样板卡写进本地库（data/himuro.db，已被 gitignore）。
// 幂等：按「名字 + 模板标记」查重。用法：node scripts/add-kurisu.mjs
import fs from "node:fs";
import Database from "better-sqlite3";

const card = JSON.parse(fs.readFileSync(new URL("../lib/personas/kurisu.json", import.meta.url), "utf8"));
const db = new Database("data/himuro.db");
const now = Date.now();
const uid = () => crypto.randomUUID();

const existing = db
  .prepare("SELECT id FROM characters WHERE name=? AND is_template=1")
  .get(card.name);
if (existing && !process.argv.includes("--force")) {
  console.log(`√ 已存在模板角色「${card.name}」（id ${existing.id}），跳过（--force 可覆盖）`);
  process.exit(0);
}

let charId;
if (existing) {
  charId = existing.id;
  const wbRow = db.prepare("SELECT id FROM worldbooks WHERE character_id=?").get(charId);
  db.prepare("DELETE FROM worldbooks WHERE character_id=?").run(charId);
  if (wbRow) db.prepare("DELETE FROM wb_entries WHERE worldbook_id=?").run(wbRow.id);
  console.log(`√ 覆盖模板角色「${card.name}」（id ${charId}）`);
} else {
  charId = uid();
}
const cardCols =
  'name=?,emoji=?,color=?,identity=?,speech_style=?,"values"=?,boundaries=?,user_addressing=?,relationship=?,first_message=?,examples_json=?,persona_inject=?,updated_at=?';
const cardParams = [
  card.name,
  card.emoji,
  card.color,
  card.identity,
  card.speechStyle,
  card.values,
  card.boundaries,
  card.userAddressing,
  card.relationship,
  card.firstMessage,
  JSON.stringify(card.examples),
  card.personaInject,
  now,
];
if (existing) {
  db.prepare(`UPDATE characters SET ${cardCols} WHERE id=?`).run(...cardParams, charId);
} else {
  db.prepare(
    'INSERT INTO characters (id,name,emoji,color,identity,speech_style,"values",boundaries,user_addressing,relationship,first_message,examples_json,persona_inject,is_template,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
  ).run(charId, ...cardParams, now);
}
const wbId = uid();
db.prepare("INSERT INTO worldbooks (id,character_id,name,created_at) VALUES (?,?,?,?)").run(wbId, charId, card.worldbook.name, now);
card.worldbook.entries.forEach((e, i) => {
  db.prepare(
    "INSERT INTO wb_entries (id,worldbook_id,category,title,content,keywords_json,weight,sort,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)",
  ).run(uid(), wbId, e.category, e.title, e.content, JSON.stringify(e.keywords), e.weight, i, now, now);
});

console.log(`√ 已写入「${card.name}」（${card.worldbook.entries.length} 条世界书条目）id ${charId}`);
