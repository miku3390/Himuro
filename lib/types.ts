/** 全局共享类型与常量（前后端通用，不要 import server 专属模块） */

export type Mode = "daily" | "story";
export type Tier = "light" | "quality";
export type WbCategory = "人物" | "地点" | "事件" | "规则";

/** 群聊发言策略 */
export type GroupStrategy = "mention" | "rotate" | "all";

export const GROUP_STRATEGY_LABEL: Record<GroupStrategy, string> = {
  mention: "谁被@谁答",
  rotate: "依次发言",
  all: "全员发言",
};

export const MODE_LABEL: Record<Mode, string> = {
  daily: "日常聊天",
  story: "连载剧情",
};

export const TIER_LABEL: Record<Tier, string> = {
  light: "轻量",
  quality: "高质量",
};

export const WB_CATEGORIES: WbCategory[] = ["人物", "地点", "事件", "规则"];

/** 风月式「情绪目标」快捷项（日常模式每轮可选） */
export const EMOTION_PRESETS = ["安慰", "斗嘴", "并肩作战", "撒娇", "认真谈心"] as const;

/** 示例对话：3-5 组「用户说/角色回」锁语感 */
export type Example = { user: string; assistant: string };

export type CharacterCard = {
  id: string;
  name: string;
  emoji: string;
  color: string;
  identity: string;
  speechStyle: string;
  values: string;
  boundaries: string;
  userAddressing: string;
  relationship: string;
  firstMessage: string;
  examples: Example[];
  isTemplate: boolean;
  /** 自由人格注入（酒馆「系统备注」对等）：整段原文拼进 system prompt 的角色块之后 */
  personaInject: string;
  /** 作者注释（Author's Note 对等）：随每轮注入的强提示 */
  authorNote: string;
  /** 注释深度：0 = 附在 system prompt 末尾；1..N = 插进对话倒数第 N 条之前 */
  authorNoteDepth: number;
  /** 角色级 TTS（自部署供应商）：留空回退到设置页全局配置 */
  ttsRefAudio: string;
  ttsPromptText: string;
  ttsPromptLang: string;
  ttsLang: string;
  /** 角色级语速；0 = 未配置，回退到设置页全局语速 */
  ttsRate: number;
};

export type WbEntry = {
  id: string;
  worldbookId: string;
  category: WbCategory;
  title: string;
  content: string;
  keywords: string[];
  weight: number;
  sort: number;
  enabled: boolean;
};

export type ModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** 正则后处理规则（酒馆 Regex 对等） */
export type RegexTarget = "input" | "output";

export type RegexRule = {
  id: string;
  name: string;
  findRegex: string;
  replacement: string;
  flags: string;
  target: RegexTarget;
  enabled: boolean;
  sort: number;
};

/** 正则编译预检：写错的 findRegex 返回 null，由调用方决定如何提示 */
export function compileRegex(rule: {
  findRegex: string;
  flags: string;
}): RegExp | null {
  try {
    return new RegExp(rule.findRegex, rule.flags);
  } catch {
    return null;
  }
}

/** 角色卡 JSON 导入导出格式（Himuro 卡，v1） */
export type HimuroCardFile = {
  format: "himuro-card";
  version: 1;
  card: Omit<CharacterCard, "id" | "isTemplate">;
};

export function parseExamples(json: string): Example[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** GPT-SoVITS api_v2 的 speed_factor 实测有效区间（docs/GPT-SOVITS-API.md §3.1） */
export const TTS_SPEED_MIN = 0.6;
export const TTS_SPEED_MAX = 1.65;

/**
 * 语速归一化：夹到实测有效区间。
 * allowZero=true 时，0 表示「角色未配置语速」并原样保留（留空回退全局），
 * 否则 0 与非法值一律按 1.0 处理。
 */
export function clampTtsRate(v: number, allowZero = false): number {
  if (!Number.isFinite(v)) return allowZero ? 0 : 1;
  if (allowZero && v <= 0) return 0;
  return Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, v));
}
