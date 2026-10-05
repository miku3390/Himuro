"use client";

import type { TtsProvider } from "@/lib/settings";

/**
 * TTS 客户端统一入口。三种供应商：
 * - browser：Web Speech API（零依赖离线），音色/语速/音调可调
 * - gptsovits / openai：走服务端 /api/tts 代理（本模块只管播音频）
 *
 * 供应商参数保存在设置页（SQLite），同时同步一份到 localStorage，
 * 聊天页试听时据此选择链路（避免每条消息多一次配置请求）。
 *
 * Phase 3 可在此扩展：按角色选参考音频（GPT-SoVITS 换 ref 即换音色）、批量导出。
 */

export type TtsOptions = { voiceURI?: string; rate?: number; pitch?: number };

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** 当前生效的供应商（localStorage 同步值；默认 browser） */
export function currentProvider(): TtsProvider {
  if (typeof window === "undefined") return "browser";
  const v = localStorage.getItem("himuro-tts-provider");
  return v === "gptsovits" || v === "openai" ? v : "browser";
}

/** 中文语音列表（Windows 自带 Microsoft Xiaoxiao/Huihui 等），browser 供应商用 */
export function getChineseVoices(): { uri: string; name: string }[] {
  if (!ttsSupported()) return [];
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith("zh"))
    .map((v) => ({ uri: v.voiceURI, name: `${v.name} (${v.lang})` }));
}

async function playServerTts(text: string): Promise<void> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `TTS 失败 ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  audio.onerror = () => URL.revokeObjectURL(url);
  await audio.play();
}

function playBrowserTts(text: string, opts: TtsOptions = {}) {
  if (!ttsSupported()) throw new Error("此浏览器不支持 Web Speech API");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const picked = opts.voiceURI ? voices.find((v) => v.voiceURI === opts.voiceURI) : undefined;
  if (picked) u.voice = picked;
  u.lang = picked?.lang || "zh-CN";
  u.rate = opts.rate ?? 1;
  u.pitch = opts.pitch ?? 1;
  speechSynthesis.speak(u);
}

/** 统一入口：按当前供应商朗读。返回 provider 便于 UI 提示 */
export async function speak(
  text: string,
  opts: TtsOptions = {},
): Promise<"browser" | "server"> {
  const provider = currentProvider();
  if (provider === "browser") {
    playBrowserTts(text, opts);
    return "browser";
  }
  await playServerTts(text);
  return "server";
}

export function stopSpeak() {
  if (ttsSupported()) speechSynthesis.cancel();
}
