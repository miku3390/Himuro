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
  /** 角色级 TTS（自部署供应商）：留空回退到设置页全局配置 */
  ttsRefAudio: string;
  ttsPromptText: string;
  ttsPromptLang: string;
  ttsLang: string;
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
