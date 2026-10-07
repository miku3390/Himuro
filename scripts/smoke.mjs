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
ok(kinds.join("→") === "user_msg→hits→tok→done", `事件序列 user_msg→hits→tok→done（实际 ${kinds.join("→")}）`);
ok(hits.some((h) => h.title === "周六看海的约定"), "世界书命中「周六看海的约定」");
ok(!!reply1?.messageId, "回复落库");
ok(
  first.events[0]?.t === "user_msg" && first.events[0]?.id === reply1?.userMessageId,
  "开头的 user_msg 给出了用户消息真 id（流中断时客户端靠它才能继续编辑/删除）",
);

const count1 = () => db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=?").get(convId).n;
ok(count1() === 2, `消息数=2（实际 ${count1()}）`);

/* ---------- 2. 重Roll → 兄弟分支 ---------- */
const userRow = db
  .prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY idx")
  .get(convId);
const reroll = await chat({ reroll: true, rerollMessageId: reply1.messageId });
const reply2 = reroll.events.find((e) => e.t === "done");
ok(reroll.res.status === 200 && !!reply2?.messageId, "重Roll 成功返回新回复");
ok(reply2.messageId !== reply1.messageId, "重Roll 产生了新消息 id");
const oldKept = db.prepare("SELECT count(*) n FROM messages WHERE id=?").get(reply1.messageId).n;
ok(oldKept === 1, "旧回复保留（分支树不再删除）");
ok(count1() === 3, `重Roll 后消息数=3（实际 ${count1()}）`);
const r1 = db.prepare("SELECT parent_id FROM messages WHERE id=?").get(reply1.messageId);
const r2 = db.prepare("SELECT parent_id FROM messages WHERE id=?").get(reply2.messageId);
ok(r1.parent_id === userRow.id, "旧回复挂在用户消息下");
ok(r2.parent_id === r1.parent_id, "新回复与旧回复是兄弟（同父）");
const parentActive = db
  .prepare("SELECT active_child_id FROM messages WHERE id=?")
  .get(userRow.id).active_child_id;
ok(parentActive === reply2.messageId, "父消息活跃指针指向新回复");

// 无 target 重Roll：对活跃路径末尾（reply2）重Roll → 第三条兄弟
const reroll2 = await chat({ reroll: true });
const reply3 = reroll2.events.find((e) => e.t === "done");
const r3 = db.prepare("SELECT parent_id FROM messages WHERE id=?").get(reply3.messageId);
ok(!!reply3?.messageId && reply3.messageId !== reply2.messageId, "无 target 重Roll 也生成新兄弟");
ok(r3.parent_id === r1.parent_id, "第三条兄弟挂载点正确");
ok(count1() === 4, `消息数=4（实际 ${count1()}）`);

// DB 级切回第一版分支 → 再重Roll：挂载点应跟随切换后的活跃路径（兄弟语义验证）
db.prepare("UPDATE messages SET active_child_id=? WHERE id=?").run(reply1.messageId, userRow.id);
const reroll3 = await chat({ reroll: true });
const reply4 = reroll3.events.find((e) => e.t === "done");
const r4 = db.prepare("SELECT parent_id FROM messages WHERE id=?").get(reply4.messageId);
ok(!!reply4?.messageId && r4.parent_id === r1.parent_id, "切回旧分支后重Roll 挂载点正确");
ok(count1() === 5, `消息数=5（实际 ${count1()}）`);

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

// 4d. 群聊重Roll：即使群策略是 all，也只让原发言人重答；分支树不删旧回复（消息数 +1）
const gTarget = db
  .prepare("SELECT id FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY idx")
  .all(gConvId)
  .at(-1);
const gMsgCountBefore = db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=?").get(gConvId).n;
const g4 = await chat({ conversationId: gConvId, reroll: true, rerollMessageId: gTarget.id });
const spk4 = g4.events.filter((e) => e.t === "speakers").at(-1)?.speakers ?? [];
ok(spk4.length === 1, `群聊重Roll 只让原发言人重答（实际 ${spk4.map((s) => s.name).join(",") || "无人"}）`);
const gMsgCountAfter = db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=?").get(gConvId).n;
ok(gMsgCountAfter === gMsgCountBefore + 1, `群聊重Roll 生成兄弟分支（${gMsgCountBefore} → ${gMsgCountAfter}）`);
const gNew = db
  .prepare("SELECT parent_id, character_id FROM messages WHERE conversation_id=? AND id != ?")
  .all(gConvId, gTarget.id)
  .at(-1);
ok(gNew?.parent_id === db.prepare("SELECT parent_id FROM messages WHERE id=?").get(gTarget.id).parent_id,
  "群聊重Roll 的新回复与旧回复同父（兄弟分支）");

// 清理群聊
db.prepare("DELETE FROM messages WHERE conversation_id=?").run(gConvId);
db.prepare("DELETE FROM conv_members WHERE conversation_id=?").run(gConvId);
db.prepare("DELETE FROM conversations WHERE id=?").run(gConvId);

/* ---------- 5. 切句纯函数（Node 24 原生跑 TS） ---------- */
const { splitSentences } = await import("../lib/ttsText.ts");
const s1 = splitSentences("今天下午我们一起去秋叶原买新出的手办模型。晚上再看一直想看的电影。");
ok(s1.length === 2 && s1[0].endsWith("。"), `按句末标点切分（${JSON.stringify(s1)}）`);
const s2 = splitSentences("这是一个特别长的句子，".repeat(15), 100);
ok(s2.length === 2 && s2.every((x) => x.length <= 100), `超长句在逗号处硬切且不超上限（${s2.length} 段）`);
ok(splitSentences("你好呀。今天天气怎么样？走吧！").length === 1, "过短句子合并为一段");
ok(splitSentences("   ").length === 0, "空文本返回空数组");

/* ---------- 6. 自部署 TTS 代理 ---------- */
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
    body: JSON.stringify({ text: "冒烟测试，忍野扇的语音。", speed: 0.9 }), // 语速走 speed_factor，服务端会夹到 0.6~1.65
  });
  const ct = ttsRes.headers.get("content-type") ?? "";
  const bytes = (await ttsRes.arrayBuffer()).byteLength;
  ok(ttsRes.ok && ct.startsWith("audio/") && bytes > 10000, `TTS 代理返回音频（${ct}, ${bytes} bytes）`);
  const cacheHeader = ttsRes.headers.get("x-himuro-tts-cache");
  ok(cacheHeader === "hit" || cacheHeader === "miss", `缓存头存在（${cacheHeader}）`);

  // 同文本第二次请求应命中磁盘缓存
  const ttsResAgain = await fetch("http://localhost:3000/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "冒烟测试，忍野扇的语音。", speed: 0.9 }),
  });
  const bytesAgain = (await ttsResAgain.arrayBuffer()).byteLength;
  ok(
    ttsResAgain.headers.get("x-himuro-tts-cache") === "hit" && bytesAgain === bytes,
    "同文本第二次请求命中缓存（内容一致）",
  );

  // 角色级覆盖：建一个带扇参考音频的临时角色，带 characterId 请求应同样出音频
  const ttsCharId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO characters (id, name, identity, tts_ref_audio, tts_prompt_text, tts_prompt_lang, tts_lang, tts_rate, is_template, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)",
  ).run(
    ttsCharId,
    "TTS测试角色",
    "测试用",
    "/home/miku/GPT-SoVITS/GPT_SoVITS/output/切片/vocal_扇_原声.wav_20.wav_0000020800_0000234240.wav",
    "しかしそれはともかくとして、あららぎ先輩、仲間を頼るのは悪いことではありませんが",
    "ja",
    "zh",
    1.4,
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
  ok(ttsRes2.ok && ct2.startsWith("audio/") && bytes2 > 10000, `角色级 TTS 覆盖（音色+语速 1.4）生效（${ct2}, ${bytes2} bytes）`);

  // 语速真的传到了模型：同一句话，慢速档的音频必须比快速档长
  const wavSeconds = (buf) => {
    const sr = buf.readUInt32LE(24);
    const ch = buf.readUInt16LE(22);
    const bits = buf.readUInt16LE(34);
    return (buf.length - 44) / (sr * ch * (bits / 8));
  };
  const synthAt = async (speed) => {
    const r = await fetch("http://localhost:3000/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好，我是忍野扇。", speed }),
    });
    return wavSeconds(Buffer.from(await r.arrayBuffer()));
  };
  const slow = await synthAt(0.7);
  const fast = await synthAt(1.5);
  ok(slow > fast, `语速生效：0.7x 比 1.5x 长（${slow.toFixed(2)}s vs ${fast.toFixed(2)}s）`);
  db.prepare("DELETE FROM characters WHERE id=?").run(ttsCharId);
}

/* ---------- 7. ST 卡 PNG 导出闭环 ---------- */
function readCharaFromPngBytes(buf) {
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (type === "tEXt") {
      const data = buf.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0 && data.toString("latin1", 0, nul) === "chara") {
        return JSON.parse(Buffer.from(data.toString("latin1", nul + 1), "base64").toString("utf8"));
      }
    }
    off += 12 + len;
  }
  return null;
}
const cardPngRes = await fetch("http://localhost:3000/api/export/card", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ characterId: imp.id }),
});
const cardPng = Buffer.from(await cardPngRes.arrayBuffer());
ok(
  cardPngRes.ok &&
    cardPng.readUInt32BE(8) === 13 &&
    cardPng.toString("latin1", 12, 16) === "IHDR" &&
    readCharaFromPngBytes(cardPng)?.data?.name === "星霜",
  "ST 卡 PNG 导出：结构合法且 tEXt chara 可解析",
);
ok(readCharaFromPngBytes(cardPng)?.spec === "chara_card_v2", "卡数据为 V2 规格");

const fd2 = new FormData();
fd2.append("file", new Blob([cardPng], { type: "image/png" }), "reimport.png");
const imp2Res = await fetch("http://localhost:3000/api/import/card", { method: "POST", body: fd2 });
const imp2 = await imp2Res.json();
ok(imp2Res.ok && imp2.name === "星霜", `导出的 PNG 能再导入（roundtrip）`);

/* ---------- 8. 会话导出 → 导入 ---------- */
const exportRes = await fetch(`http://localhost:3000/api/export?conversationId=${convId}&format=json`);
const exportJson = await exportRes.json();
ok(
  exportRes.ok &&
    exportJson.format === "himuro-chat" &&
    exportJson.conversation.characterId === char.id,
  "会话导出 JSON 含 characterId（无损导入用）",
);
const impConvRes = await fetch("http://localhost:3000/api/import/conversation", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(exportJson),
});
const impConv = await impConvRes.json();
ok(impConvRes.ok && impConv.imported === 5, `会话导入成功（${impConv.imported} 条）`);
const impConvRows = db
  .prepare("SELECT role FROM messages WHERE conversation_id=? ORDER BY idx")
  .all(impConv.id);
ok(impConvRows.length === 5 && impConvRows[0].role === "user", "导入消息线性成链且条数一致");

// 清理导入的会话与二次导入的角色
db.prepare("DELETE FROM messages WHERE conversation_id=?").run(impConv.id);
db.prepare("DELETE FROM conversations WHERE id=?").run(impConv.id);
if (imp2.id) {
  const imp2Wb = db.prepare("SELECT id FROM worldbooks WHERE character_id=?").get(imp2.id);
  if (imp2Wb) {
    db.prepare("DELETE FROM wb_entries WHERE worldbook_id=?").run(imp2Wb.id);
    db.prepare("DELETE FROM worldbooks WHERE id=?").run(imp2Wb.id);
  }
  db.prepare("DELETE FROM characters WHERE id=?").run(imp2.id);
}

/* ---------- 9. 全库备份 → 恢复 ---------- */
const backupRes = await fetch("http://localhost:3000/api/backup");
const backup = await backupRes.json();
ok(
  backupRes.ok &&
    backup.format === "himuro-backup" &&
    Array.isArray(backup.tables.characters) &&
    backup.tables.characters.length > 0,
  `全库备份导出（${backup.tables?.characters?.length ?? 0} 个角色）`,
);
// 备份之后塞进来的东西，恢复后应消失
const tmpCharId = crypto.randomUUID();
db.prepare(
  "INSERT INTO characters (id, name, identity, is_template, created_at, updated_at) VALUES (?,?,?,?,?,?)",
).run(tmpCharId, "备份恢复测试临时角色", "", 0, now, now);
const restoreRes = await fetch("http://localhost:3000/api/backup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(backup),
});
const restore = await restoreRes.json();
ok(restoreRes.ok && restore.ok, "全库恢复成功");
const tmpGone = db.prepare("SELECT count(*) n FROM characters WHERE id=?").get(tmpCharId).n;
ok(tmpGone === 0, "恢复把备份之后的改动回滚了");
ok(db.prepare("SELECT count(*) n FROM characters WHERE name='小满'").get().n === 1, "原有数据完好");

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
