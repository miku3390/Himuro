"use client";

import type { TtsProvider } from "@/lib/settings";

/**
 * TTS 客户端统一入口。三种供应商：
 * - browser：Web Speech API（零依赖离线），音色/语速/音调可调
 * - gptsovits / openai：走服务端 /api/tts 代理，请求组装见 app/api/tts/route.ts
 *
 * 供应商参数保存在设置页（SQLite），同时同步一份到 localStorage，
 * 聊天页试听时据此选择链路（避免每条消息多一次配置请求）。
 *
 * 同一时刻只允许一段音频在响：新的朗读先掐掉上一段，连在路上的合成请求一起 abort，
 * GPT-SoVITS 合成慢（冷启动可到十几秒），不这么做连点两条消息就会叠着播。
 */

export type TtsOptions = { voiceURI?: string; rate?: number; pitch?: number };

/** 模块级单例：当前在播的音频、它的 objectURL、以及还没回来的那次合成请求 */
let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let currentAbort: AbortController | null = null;

/** 停掉服务端音频链路（含在途请求与 objectURL 回收）。可重复调用 */
function releaseServerAudio() {
  currentAbort?.abort();
  currentAbort = null;
  if (currentAudio) {
    // 先摘掉回调，避免 pause/换源触发的 ended/error 又回头调用本函数
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

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

async function playServerTts(text: string, characterId?: string): Promise<void> {
  releaseServerAudio();
  const abort = new AbortController();
  currentAbort = abort;
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, characterId }),
    signal: abort.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `TTS 失败 ${res.status}`);
  }
  const blob = await res.blob();
  if (abort.signal.aborted) return; // 音频回来了，但这期间已经被新的朗读顶掉
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  currentUrl = url;
  const cleanup = () => {
    if (currentAudio === audio) releaseServerAudio();
  };
  audio.onended = cleanup;
  audio.onerror = cleanup;
  try {
    await audio.play();
  } catch (err) {
    // 被新的朗读 pause 掉时 play() 会抛 AbortError，属于正常抢占，不当错误上报
    if (!(err instanceof DOMException && err.name === "AbortError")) throw err;
  }
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

/** 统一入口：按当前供应商朗读。characterId 传入时服务端优先用该角色自己的音色配置 */
export async function speak(
  text: string,
  opts: TtsOptions & { characterId?: string } = {},
): Promise<"browser" | "server"> {
  const provider = currentProvider();
  if (provider === "browser") {
    releaseServerAudio(); // 换到浏览器音色时，别让上一条服务端音频还在响
    playBrowserTts(text, opts);
    return "browser";
  }
  await playServerTts(text, opts.characterId);
  return "server";
}

/** 停掉一切语音：浏览器合成与服务端音频都停 */
export function stopSpeak() {
  if (ttsSupported()) speechSynthesis.cancel();
  releaseServerAudio();
}
