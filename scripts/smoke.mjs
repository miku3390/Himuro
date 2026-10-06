// 冒烟测试：建临时会话 → 聊天 SSE → 重Roll → ST卡导入 → 校验 → 清理
import Database from "better-sqlite3";

const db = new Database("data/himuro.db");
let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "✓ " : "✗ ") + label);
  if (!cond) failed++;
};

/* ---------- 1. 聊天 SSE ---------- */
const char = db.prepare("SELECT * FROM characters WHERE name='小满'").get();
const convId = crypto.randomUUID();
const now = Date.now();
db.prepare(
  "INSERT INTO conversations (id, character_id, title, mode, tier, chapter, summary_text, summarized_count, created_at, updated_at) VALUES (?,?,?,?,?,1,'',0,?,?)",
).run(convId, char.id, "冒烟测试 · 日常", "daily", "light", now, now);

async function chat(payload) {
  const res = await fetch("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: convId, ...payload }),
  });
  const text = await res.text();
  const events = text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.trim().slice(5)));
  return { res, events };
}

const first = await chat({ content: "周六去海边看日出的事情还作数吗？", emotion: "安慰" });
const kinds = [...new Set(first.events.map((e) => e.t))];
const hits = first.events.find((e) => e.t === "hits")?.hits ?? [];
const reply1 = first.events.find((e) => e.t === "done");
ok(first.res.status === 200, "聊天 HTTP 200");
ok(kinds.join("→") === "hits→tok→done", `事件序列 hits→tok→done（实际 ${kinds.join("→")}）`);
ok(hits.some((h) => h.title === "周六看海的约定"), "世界书命中「周六看海的约定」");
ok(!!reply1?.messageId, "回复落库");

const count1 = () => db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=?").get(convId).n;
ok(count1() === 2, `消息数=2（实际 ${count1()}）`);

/* ---------- 2. 重Roll ---------- */
const reroll = await chat({ reroll: true, rerollMessageId: reply1.messageId });
const reply2 = reroll.events.find((e) => e.t === "done");
ok(reroll.res.status === 200 && !!reply2?.messageId, "重Roll 成功返回新回复");
ok(reply2.messageId !== reply1.messageId, "重Roll 产生了新消息 id");
const oldGone = db.prepare("SELECT count(*) n FROM messages WHERE id=?").get(reply1.messageId).n;
ok(oldGone === 0, "旧回复已被删除");
ok(count1() === 2, `重Roll 后消息数仍=2（实际 ${count1()}）`);

/* ---------- 3. SillyTavern PNG 卡导入 ---------- */
const stCard = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "星霜",
    description: "{{char}}是一位剑修，冷面热心。",
    personality: "寡言，句短，涉及旧事会沉默。",
    scenario: "与{{user}}在雪夜的山道相遇。",
    first_mes: "{{char}}拂去肩上的雪：「阁下也是来避雪的？」",
    mes_example:
      "<START>\n{{user}}: 你冷吗？\n{{char}}: 尚可。\n<START>\n{{user}}: 走吧。\n{{char}}: 嗯。前面就是山神庙。",
  },
};
function makePngCard(cardJson) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const textData = Buffer.concat([
    Buffer.from("chara", "latin1"),
    Buffer.alloc(1),
    Buffer.from(Buffer.from(JSON.stringify(cardJson)).toString("base64"), "latin1"),
  ]);
  return Buffer.concat([sig, chunk("IHDR", Buffer.alloc(13)), chunk("tEXt", textData), chunk("IEND", Buffer.alloc(0))]);
}

const fd = new FormData();
fd.append("file", new Blob([makePngCard(stCard)], { type: "image/png" }), "card.png");
const impRes = await fetch("http://localhost:3000/api/import/card", { method: "POST", body: fd });
const imp = await impRes.json();
ok(impRes.ok && imp.name === "星霜", `PNG 卡导入成功（${JSON.stringify(imp)}）`);

const impRow = imp.id ? db.prepare("SELECT * FROM characters WHERE id=?").get(imp.id) : null;
ok(impRow?.identity === "星霜是一位剑修，冷面热心。", "description 宏已替换并映射到 identity");
ok((impRow?.first_message ?? "").includes("星霜拂去肩上的雪"), "first_mes 宏已替换");
const impExamples = JSON.parse(impRow?.examples_json ?? "[]");
ok(impExamples.length === 2 && impExamples[0].user === "你冷吗？", `mes_example 解析出 2 组示例（实际 ${impExamples.length}）`);

const impWb = imp.id ? db.prepare("SELECT id FROM worldbooks WHERE character_id=?").get(imp.id) : null;
ok(!!impWb, "导入角色自动建了世界书");

/* ---------- 4. 群聊 ---------- */
const lin = db.prepare("SELECT * FROM characters WHERE name='凛'").get();
const gConvId = crypto.randomUUID();
db.prepare(
  "INSERT INTO conversations (id, character_id, title, mode, tier, chapter, summary_text, summarized_count, group_strategy, created_at, updated_at) VALUES (?,?,?,?,?,1,'',0,'mention',?,?)",
).run(gConvId, char.id, "冒烟群聊 · 日常", "daily", "light", now, now);
const insMember = db.prepare(
  "INSERT INTO conv_members (id, conversation_id, character_id, sort, joined_at) VALUES (?,?,?,?,?)",
);
insMember.run(crypto.randomUUID(), gConvId, char.id, 0, now); // 小满
insMember.run(crypto.randomUUID(), gConvId, lin.id, 1, now); // 凛

// 4a. mention：点名「凛」→ 只有凛回应
const g1 = await chat({ conversationId: gConvId, content: "凛，周末一起黑客马拉松吗？" });
const spk1 = g1.events.filter((e) => e.t === "speakers").at(-1)?.speakers ?? [];
const doneRows1 = g1.events.filter((e) => e.t === "speaker_done");
ok(spk1.length === 1 && spk1[0].name === "凛", `mention 点名只让凛发言（实际 ${spk1.map((s) => s.name).join(",")}）`);
ok(doneRows1.length === 1, "凛的回复经 speaker_done 落库");
const g1msg = db.prepare("SELECT character_id FROM messages WHERE id=?").get(doneRows1[0].messageId);
ok(g1msg?.character_id === lin.id, "群聊回复记录了发言人 characterId");

// 4b. mention 无点名 → 轮换下一位（上一位凛 → 小满）
const g2 = await chat({ conversationId: gConvId, content: "大家最近怎么样？" });
const spk2 = g2.events.filter((e) => e.t === "speakers").at(-1)?.speakers ?? [];
ok(spk2.length === 1 && spk2[0].name === "小满", `无点名时轮换到小满（实际 ${spk2.map((s) => s.name).join(",")}）`);

// 4c. all 策略 → 全员按顺序发言
db.prepare("UPDATE conversations SET group_strategy='all' WHERE id=?").run(gConvId);
const g3 = await chat({ conversationId: gConvId, content: "最终决定：周六出发。" });
const spk3 = g3.events.filter((e) => e.t === "speakers").at(-1)?.speakers ?? [];
const doneRows3 = g3.events.filter((e) => e.t === "speaker_done");
ok(spk3.length === 2 && spk3[0].name === "小满" && spk3[1].name === "凛", `全员按顺序发言（实际 ${spk3.map((s) => s.name).join("→")}）`);
ok(doneRows3.length === 2, "两位成员的回复都落库");
const assistantCount = db
  .prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND role='assistant'")
  .get(gConvId).n;
ok(assistantCount === 4, `群聊共 4 条角色回复（实际 ${assistantCount}）`);

// 清理群聊
db.prepare("DELETE FROM messages WHERE conversation_id=?").run(gConvId);
db.prepare("DELETE FROM conv_members WHERE conversation_id=?").run(gConvId);
db.prepare("DELETE FROM conversations WHERE id=?").run(gConvId);

/* ---------- 5. 自部署 TTS 代理 ---------- */
const ttsCfg = db.prepare("SELECT tts_provider, tts_base_url FROM settings WHERE id=1").get();
const gptReachable = await fetch("http://127.0.0.1:9880/docs")
  .then((r) => r.ok)
  .catch(() => false);
if (ttsCfg.tts_provider === "gptsovits" && !gptReachable) {
  console.log("- GPT-SoVITS 服务未运行，跳过 TTS 用例（启动: wsl bash ~/GPT-SoVITS/start_api.sh）");
} else {
  const ttsRes = await fetch("http://localhost:3000/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "冒烟测试，忍野扇的语音。" }),
  });
  const ct = ttsRes.headers.get("content-type") ?? "";
  const bytes = (await ttsRes.arrayBuffer()).byteLength;
  ok(ttsRes.ok && ct.startsWith("audio/") && bytes > 10000, `TTS 代理返回音频（${ct}, ${bytes} bytes）`);

  // 角色级覆盖：建一个带扇参考音频的临时角色，带 characterId 请求应同样出音频
  const ttsCharId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO characters (id, name, identity, tts_ref_audio, tts_prompt_text, tts_prompt_lang, tts_lang, is_template, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)",
  ).run(
    ttsCharId,
    "TTS测试角色",
    "测试用",
    "/home/miku/GPT-SoVITS/GPT_SoVITS/output/切片/vocal_扇_原声.wav_20.wav_0000020800_0000234240.wav",
    "しかしそれはともかくとして、あららぎ先輩、仲間を頼るのは悪いことではありませんが",
    "ja",
    "zh",
    now,
    now,
  );
  const ttsRes2 = await fetch("http://localhost:3000/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "角色级音色测试。", characterId: ttsCharId }),
  });
  const ct2 = ttsRes2.headers.get("content-type") ?? "";
  const bytes2 = (await ttsRes2.arrayBuffer()).byteLength;
  ok(ttsRes2.ok && ct2.startsWith("audio/") && bytes2 > 10000, `角色级 TTS 覆盖生效（${ct2}, ${bytes2} bytes）`);
  db.prepare("DELETE FROM characters WHERE id=?").run(ttsCharId);
}

/* ---------- 6. 导出（复盘用，必须脱敏） ---------- */
const expRes = await fetch(`http://localhost:3000/api/export?conversationId=${convId}&format=json`);
const exp = await expRes.json();
ok(expRes.ok && exp.model?.tier === "light", `导出 JSON 带档位（${JSON.stringify(exp.model)}）`);
ok(
  typeof exp.model?.name === "string" && !("apiKey" in (exp.model ?? {})) && !exp.model?.baseUrl,
  "导出只带档位与模型名，不含 apiKey / baseUrl",
);
ok(Array.isArray(exp.messages) && exp.messages.length === 2, `导出含 2 条消息（实际 ${exp.messages?.length}）`);

/* ---------- 清理 ---------- */
db.prepare("DELETE FROM messages WHERE conversation_id=?").run(convId);
db.prepare("DELETE FROM conversations WHERE id=?").run(convId);
if (imp.id) {
  db.prepare("DELETE FROM wb_entries WHERE worldbook_id=?").run(impWb.id);
  db.prepare("DELETE FROM worldbooks WHERE id=?").run(impWb.id);
  db.prepare("DELETE FROM characters WHERE id=?").run(imp.id);
}
console.log("临时数据已清理");

if (failed) {
  console.error(`${failed} 项未通过`);
  process.exit(1);
}
console.log("全部通过 ✅");
