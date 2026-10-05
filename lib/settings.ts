import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import type { ModelConfig, Tier } from "@/lib/types";

/** 设置单行表封装。默认值全部指向内置演示模型，开箱即用。 */

export type TtsProvider = "browser" | "gptsovits" | "openai";

export type AppSettings = {
  light: ModelConfig;
  quality: ModelConfig;
  embed: { baseUrl: string; apiKey: string; model: string };
  summaryEveryTurns: number;
  wbMaxHits: number;
  vecTopK: number;
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
  tts: {
    provider: TtsProvider;
    baseUrl: string;
    lang: string;
    refAudio: string;
    promptText: string;
    promptLang: string;
    model: string;
    voice: string;
  };
};

export function getSettings(): AppSettings {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!row) throw new Error("设置行不存在，请重启应用（应自动种子化）");
  return {
    light: {
      baseUrl: row.lightBaseUrl,
      apiKey: row.lightApiKey,
      model: row.lightModel,
    },
    quality: {
      baseUrl: row.qualityBaseUrl,
      apiKey: row.qualityApiKey,
      model: row.qualityModel,
    },
    embed: {
      baseUrl: row.embedBaseUrl,
      apiKey: row.embedApiKey,
      model: row.embedModel,
    },
    summaryEveryTurns: row.summaryEveryTurns,
    wbMaxHits: row.wbMaxHits,
    vecTopK: row.vecTopK,
    ttsVoice: row.ttsVoice,
    ttsRate: row.ttsRate,
    ttsPitch: row.ttsPitch,
    tts: {
      provider: (["browser", "gptsovits", "openai"].includes(row.ttsProvider)
        ? row.ttsProvider
        : "browser") as AppSettings["tts"]["provider"],
      baseUrl: row.ttsBaseUrl,
      lang: row.ttsLang,
      refAudio: row.ttsRefAudio,
      promptText: row.ttsPromptText,
      promptLang: row.ttsPromptLang,
      model: row.ttsModel,
      voice: row.ttsOpenaiVoice,
    },
  };
}

export function saveSettings(patch: Partial<AppSettings>) {
  const now = Date.now();
  db.update(settings)
    .set({
      lightBaseUrl: patch.light?.baseUrl,
      lightApiKey: patch.light?.apiKey,
      lightModel: patch.light?.model,
      qualityBaseUrl: patch.quality?.baseUrl,
      qualityApiKey: patch.quality?.apiKey,
      qualityModel: patch.quality?.model,
      embedBaseUrl: patch.embed?.baseUrl,
      embedApiKey: patch.embed?.apiKey,
      embedModel: patch.embed?.model,
      summaryEveryTurns: patch.summaryEveryTurns,
      wbMaxHits: patch.wbMaxHits,
      vecTopK: patch.vecTopK,
      ttsVoice: patch.ttsVoice,
      ttsRate: patch.ttsRate,
      ttsPitch: patch.ttsPitch,
      ttsProvider: patch.tts?.provider,
      ttsBaseUrl: patch.tts?.baseUrl,
      ttsLang: patch.tts?.lang,
      ttsRefAudio: patch.tts?.refAudio,
      ttsPromptText: patch.tts?.promptText,
      ttsPromptLang: patch.tts?.promptLang,
      ttsModel: patch.tts?.model,
      ttsOpenaiVoice: patch.tts?.voice,
      updatedAt: now,
    })
    .where(eq(settings.id, 1))
    .run();
}

/** 某一档的模型配置；baseUrl 为 "mock" 时走内置演示模型 */
export function modelFor(s: AppSettings, tier: Tier): ModelConfig {
  return s[tier];
}
