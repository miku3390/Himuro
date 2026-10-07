import "server-only";
import type { Example } from "@/lib/types";

/**
 * SillyTavern 角色卡导入：PNG 卡（tEXt chunk）+ V1/V2/V3 JSON 卡 → Himuro 卡。
 *
 * PNG 卡规格（社区惯例）：PNG 文件的 tEXt chunk，keyword 为 "chara"（V1/V2）
 * 或 "ccv3"（V3），value 是 base64 编码的卡 JSON。
 */

const MAX_FIELD = 4000;

export type NormalizedCard = {
  name: string;
  identity: string;
  speechStyle: string;
  values: string;
  boundaries: string;
  userAddressing: string;
  relationship: string;
  firstMessage: string;
  examples: Example[];
};

/** 从 PNG 二进制里提取角色卡 JSON 文本；非 PNG 或没有卡数据返回 null */
export function readCharaFromPng(bytes: Uint8Array): string | null {
  // PNG 签名：89 50 4E 47 0D 0A 1A 0A
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) return null;
  }
  const buf = Buffer.from(bytes);
  let off = 8;
  let fallback: string | null = null; // V3 卡优先（ccv3），chara 作后备
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (type === "tEXt") {
      const data = buf.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = data.toString("latin1", 0, nul);
        if (keyword === "ccv3" || keyword === "chara") {
          const json = Buffer.from(data.toString("latin1", nul + 1), "base64").toString("utf8");
          if (keyword === "ccv3") return json;
          fallback = fallback ?? json;
        }
      }
    }
    off += 12 + len; // len(4) + type(4) + data(len) + crc(4)
  }
  return fallback;
}

/** 把 {{char}}/{{user}} 等社区宏替换为 Himuro 的习惯写法 */
export function replaceMacros(text: string, charName: string): string {
  return text
    .replaceAll("{{char}}", charName)
    .replaceAll("{{user}}", "你")
    .replaceAll("<BOT>", charName)
    .replaceAll("<USER>", "你")
    .replaceAll("{{random:a,b}}", "a")
    .trim();
}

/** 解析 mes_example（<START> 分块、{{user}}:/{{char}}: 前缀）为示例对话数组 */
export function parseMesExample(raw: string, charName: string): Example[] {
  if (!raw?.trim()) return [];
  const blocks = raw.split(/<START>/i).slice(1).length ? raw.split(/<START>/i).slice(1) : [raw];
  const out: Example[] = [];
  for (const block of blocks) {
    let user = "";
    let assistant = "";
    for (const lineRaw of block.split("\n")) {
      const line = lineRaw.trimEnd();
      if (/^\s*(\{\{user\}\}|<USER>|你)\s*[:：]/i.test(line)) {
        user = line.replace(/^\s*(\{\{user\}\}|<USER>|你)\s*[:：]\s*/i, "");
      } else if (/^\s*(\{\{char\}\}|<BOT>)\s*[:：]/i.test(line)) {
        assistant = line.replace(/^\s*(\{\{char\}\}|<BOT>)\s*[:：]\s*/i, "");
      } else if (line.trim()) {
        // 续行接到上一条
        if (assistant) assistant += "\n" + line;
        else if (user) user += "\n" + line;
      }
    }
    if (user.trim() && assistant.trim()) {
      out.push({
        user: replaceMacros(user, charName).slice(0, 500),
        assistant: replaceMacros(assistant, charName).slice(0, 1500),
      });
    }
    if (out.length >= 5) break;
  }
  return out;
}

const clip = (s: unknown, n = MAX_FIELD) => (typeof s === "string" ? s.trim().slice(0, n) : "");

/**
 * 归一化三种卡格式：
 * - Himuro 卡 {format:"himuro-card", card:{...}}
 * - SillyTavern V2/V3 {spec, data:{...}}
 * - SillyTavern V1（平铺字段）
 */
export function normalizeCard(json: unknown): NormalizedCard {
  const obj = json as Record<string, unknown>;
  if (!obj || typeof obj !== "object") throw new Error("卡片内容不是合法对象");

  // Himuro 卡
  if (obj.format === "himuro-card" && obj.card) {
    const c = obj.card as Record<string, unknown>;
    return {
      name: clip(c.name, 60) || "导入角色",
      identity: clip(c.identity),
      speechStyle: clip(c.speechStyle),
      values: clip(c.values),
      boundaries: clip(c.boundaries),
      userAddressing: clip(c.userAddressing),
      relationship: clip(c.relationship),
      firstMessage: clip(c.firstMessage),
      examples: Array.isArray(c.examples) ? (c.examples as Example[]).slice(0, 5) : [],
    };
  }

  // ST V2/V3 → data；V1 → 平铺
  const d = (
    typeof obj.spec === "string" && obj.data && typeof obj.data === "object"
      ? obj.data
      : obj
  ) as Record<string, unknown>;

  const name = clip(d.name, 60) || "导入角色";
  const greetings = Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map((g) => clip(g)) : [];
  const firstMes = clip(d.first_mes) || greetings[0] || "";
  const identity = replaceMacros(clip(d.description), name);
  const personality = replaceMacros(clip(d.personality), name);

  return {
    name,
    identity,
    speechStyle: personality,
    values: "",
    boundaries: "",
    userAddressing: "",
    relationship: replaceMacros(clip(d.scenario), name),
    firstMessage: replaceMacros(firstMes, name),
    examples: parseMesExample(clip(d.mes_example), name),
  };
}

/** Himuro 卡 → SillyTavern V2 卡（PNG 导出用；values/boundaries 等无 ST 对应字段，放 extensions） */
export function toSillyTavernV2(card: {
  name: string;
  identity: string;
  speechStyle: string;
  values: string;
  boundaries: string;
  userAddressing: string;
  relationship: string;
  firstMessage: string;
  examples: Example[];
}) {
  const extras = [
    card.values && `价值观：${card.values}`,
    card.boundaries && `禁忌边界：${card.boundaries}`,
    card.userAddressing && `称呼习惯：${card.userAddressing}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: card.name,
      description: card.identity,
      personality: card.speechStyle,
      scenario: card.relationship,
      first_mes: card.firstMessage,
      mes_example: card.examples
        .map((e) => `<START>\n{{user}}: ${e.user}\n{{char}}: ${e.assistant}`)
        .join("\n"),
      creator_notes: [
        "由 Himuro（冰室）导出的 SillyTavern V2 卡。",
        extras && `补充设定：\n${extras}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: [],
      creator: "Himuro",
      character_version: "1",
      extensions: {
        himuro: {
          values: card.values,
          boundaries: card.boundaries,
          userAddressing: card.userAddressing,
        },
      },
    },
  };
}
