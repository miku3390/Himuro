// 回复质量评测（人格注入样板卡「红莉栖」）：对跑中的 Himuro 实例发起多轮对话，
// 用「可机器核验的硬规则」持续检查回复质量；报告落 data/eval/（gitignore 内，key/文本不出仓）。
//
// 用法：
//   npm run dev（先起服务）→ node scripts/eval-quality.mjs [--rounds 3] [--tier light|quality] [--repeat-check 5]
//   评测结论也打印在终端末尾；所有命中/失败逐条列出，供迭代 prompt 后回归。

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BASE = process.env.HIMURO_BASE ?? "http://localhost:3000";
const tiersArg = process.argv.includes("--tier") ? process.argv[process.argv.indexOf("--tier") + 1] : "light";
const ROUNDS = process.argv.includes("--rounds") ? Number(process.argv[process.argv.indexOf("--rounds") + 1]) || 1 : 1;
const REPEAT_CHECK = process.argv.includes("--repeat-check")
  ? Number(process.argv[process.argv.indexOf("--repeat-check") + 1]) || 5
  : 5;

const db = new Database("data/himuro.db");
const uid = () => crypto.randomUUID();

const kurisu = db.prepare("SELECT * FROM characters WHERE name='红莉栖' AND is_template=1").get();
if (!kurisu) {
  console.error("× 库里没有模板角色「红莉栖」，先跑：node scripts/add-kurisu.mjs");
  process.exit(1);
}

/* ------------------------------ 硬规则校验 ------------------------------ */

const FORBIDDEN_AI = ["作为AI", "作为 AI", "AI模型", "AI 模型", "语言模型", "作为一个AI", "对不起，我不能", "违反了我的"];
const EMOJI = /\p{Extended_Pictographic}|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const AI_RESIDUE = new RegExp(FORBIDDEN_AI.join("|"), "g");

function sentences(text) {
  return text
    .replace(/「[^」]*」/g, (m) => m.slice(1, -1)) // 引号台词保留计长
    .replace(/（[^）]*）/g, "。") // 动作括号不算
    .split(/[。！？!?…\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 单条回复的机器可验规则 */
function checkReply(text) {
  const items = [];
  const add = (ok, label) => items.push({ ok, label });

  const leaked = text.match(AI_RESIDUE);
  add(!leaked, leaked ? `入戏：出现违禁语「${leaked[0]}」` : "入戏：无 AI 自指台词");

  const you = (text.match(/[你您]/g) ?? []).length;
  add(you === 0, you === 0 ? "称呼：未用「你/您」（人格硬规则）" : `称呼：出现 ${you} 次「你/您」`);

  add(!EMOJI.test(text), "版式：无 emoji/颜文字");
  const exclaim = (text.match(/[！!]/g) ?? []).length;
  add(exclaim <= 2, exclaim <= 2 ? `版式：感叹号 ${exclaim} 个（≤2）` : `版式：感叹号 ${exclaim} 个（≤2）`);

  const sents = sentences(text);
  const long = sents.some((s) => s.length >= 30);
  // 动作描写两式皆可：话剧式括号（她抬手）或叙事式（她把记录本摞齐……）
  const action = /（[^）]{2,}）/.test(text) || /(?<!\{)她[^\n「」]{2}/.test(text);
  add(long, long ? "节奏：至少一处 30 字以上铺陈句" : "节奏：没有 30 字以上铺陈句（要求 ≥1）");
  add(action, action ? "节奏：有动作描写（括号式或叙事式）" : "节奏：没有动作描写（要求 ≥1）");

  return items;
}

/** 跨回复的全局规则 */
function checkBatch(replies) {
  const items = [];
  const tails = replies.map((r) => {
    const lines = r.split("\n").map((x) => x.trim()).filter(Boolean);
    const last = lines.at(-1) ?? "";
    return last.replace(/[。！？!?]+$/, "");
  });
  const uniq = new Set(tails).size;
  items.push({
    ok: uniq === replies.length,
    label: `反模板：${replies.length} 条回复收尾句全部不同（不同 ${uniq}/${replies.length}）`,
  });
  const lens = replies.map((r) => r.length);
  const spread = Math.max(...lens) - Math.min(...lens);
  items.push({
    ok: spread >= 30,
    label: spread >= 30 ? `长度离散度 ${spread} 字（≥30，无等长复读）` : `长度离散度只有 ${spread} 字（<30，疑似等长复读）`,
  });
  return items;
}

/* ------------------------------ 对话驱动 ------------------------------ */

async function chat(convId, payload) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: convId, ...payload }),
  });
  if (!res.ok || !res.body) throw new Error(`chat HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let hits = [];
  let lastDone = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) {
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const evt = JSON.parse(trimmed.slice(5).trim());
        if (evt.t === "tok") full += evt.v;
        else if (evt.t === "refine") full = evt.v;
        else if (evt.t === "hits") hits = evt.hits ?? [];
        else if (evt.t === "done") lastDone = evt;
        else if (evt.t === "err") throw new Error(evt.message || "服务端错误");
      }
    }
  }
  return { text: full, hits, messageId: lastDone.messageId };
}

const now = () => Date.now();
const mkConv = () => {
  const id = uid();
  db.prepare(
    "INSERT INTO conversations (id,character_id,title,mode,tier,chapter,summary_text,summarized_count,created_at,updated_at) VALUES (?,?,?,?,?,1,'',0,?,?)",
  ).run(id, kurisu.id, `评测 · 红莉栖 · ${new Date().toISOString().slice(0, 19).replace("T", " ")}`, "daily", tiersArg, now(), now());
  return id;
};

/* ------------------------------ 场景集 ------------------------------ */

// 每个场景验证一类人格硬规则；scenario 里 target 是回复内容要触达的关键词（弱校验）
const SCENARIOS = [
  { name: "基线入戏", content: "红莉栖，实验记录整理到哪一步了？我也想搭把手。", weak: ["记录"] },
  { name: "被表扬的应激", content: "红莉栖你今天真是天才，效率也太高了。", weak: ["天才", "当然", "才不是", "……"] },
  { name: "需求缺失先反问", content: "帮我看看这个方案能不能过。", weak: ["缺", "信息", "对象", "标准", "条件", "约束", "验收"] },
  { name: "世界书触发", content: "我刚路过研究所，看到冰箱里 Dr Pepper 又堆了一箱。", wbTitle: "未来道具研究所" },
  { name: "技术纠错顺序", content: "我决定把整个实验全部推倒重做，颜色参数我随手拍的。", weak: ["数据", "假设", "重做", "错误"] },
];

async function runRound(round) {
  const convId = mkConv();
  const transcript = [];
  const results = [];
  for (const sc of SCENARIOS) {
    const out = await chat(convId, { content: sc.content });
    transcript.push({ scenario: sc.name, user: sc.content, reply: out.text, hits: out.hits.map((h) => h?.title ?? String(h)) });
    const checks = checkReply(out.text);
    if (sc.weak) {
      const hit = sc.weak.some((w) => out.text.includes(w));
      checks.push({ ok: hit, label: hit ? `场景关键词命中` : `回复里没出现这些词的任何之一：${sc.weak.join("/")}` });
    }
    if (sc.wbTitle) {
      const titles = out.hits.map((h) => h?.title ?? String(h));
      const wb = titles.includes(sc.wbTitle);
      checks.push({ ok: wb, label: wb ? `世界书命中「${sc.wbTitle}」` : `世界书没命中「${sc.wbTitle}」（hits：${titles.join("、") || "无"}）` });
    }
    results.push({ scenario: sc.name, checks });
  }

  // 反模板专项：同一条 user 消息连发 REPEAT 次，收尾各不相同才合格
  const rc = await chat(convId, { content: "夜深了，今天先到这里吧。" });
  transcript.push({ scenario: "反模板专项", user: "夜深了，今天先到这里吧。", reply: rc.text, hits: rc.hits.map((h) => h?.title ?? String(h)) });
  const repeatReplies = [rc.text];
  for (let i = 1; i < REPEAT_CHECK; i++) {
    const r = await chat(convId, { content: "夜深了，今天先到这里吧。" });
    repeatReplies.push(r.text);
    transcript.push({ scenario: "反模板专项", user: "夜深了，今天先到这里吧。", reply: r.text, hits: r.hits.map((h) => h?.title ?? String(h)) });
  }
  results.push({ scenario: "反模板专项", checks: checkBatch(repeatReplies) });

  return { round, convId, results, transcript };
}

/* ------------------------------ 汇总 & 报告 ------------------------------ */

function grade(rows) {
  const total = rows.flatMap((r) => r.checks);
  const okN = total.filter((c) => c.ok).length;
  return { okN, total: total.length };
}

const rounds = [];
for (let i = 1; i <= ROUNDS; i++) {
  console.log(`—— 第 ${i}/${ROUNDS} 轮（tier=${tiersArg}）——`);
  rounds.push(await runRound(i));
}

let pass = 0;
for (const r of rounds) {
  for (const item of r.results) {
    const { okN, total } = grade([item]);
    pass += okN;
    const mark = okN === total ? "✓" : "✗";
    console.log(`${mark} [${item.scenario}] ${okN}/${total}`);
    for (const c of item.checks.filter((x) => !x.ok)) console.log(`    ✗ ${c.label}`);
  }
}
const all = [pass, rounds.reduce((n, r) => n + r.results.reduce((m, i) => m + i.checks.length, 0), 0)];
console.log(`\n合计 ${all[0]}/${all[1]} 项通过`);

fs.mkdirSync("data/eval", { recursive: true });
const file = path.join("data", "eval", `eval-${new Date().toISOString().slice(0, 19).replace(/[:T ]/g, "-")}-t${tiersArg}.json`);
fs.writeFileSync(
  file,
  JSON.stringify({ when: new Date().toISOString(), tier: tiersArg, score: `${all[0]}/${all[1]}`, rounds }, null, 2),
);
console.log(`报告已写：${file}`);
