"use client";

import { splitSentences } from "@/lib/ttsText";
import type { TtsProvider } from "@/lib/settings";

/**
 * TTS 客户端统一入口。三种供应商：
 * - browser：Web Speech API（零依赖离线），音色/语速/音调可调，按句排队朗读
 * - gptsovits / openai：走服务端 /api/tts 代理（服务端有磁盘缓存），
 *   长文本逐句合成、顺序播放，可随时停止
 *
 * 供应商参数保存在设置页（SQLite），同时同步一份到 localStorage，
 * 聊天页试听时据此选择链路（避免每条消息多一次配置请求）。
 */

export type TtsOptions = {
  voiceURI?: string;
  rate?: number;
  pitch?: number;
  characterId?: string;
  /** 逐段播放进度回调（server 供应商长文本时触发） */
  onProgress?: (index: number, total: number) => void;
};

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

/* ------------------------------ server 供应商 ------------------------------ */

let activeAudio: HTMLAudioElement | null = null;
let serverCancelled = false;

async function fetchTtsBlob(text: string, characterId?: string): Promise<{ blob: Blob; ext: string }> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, characterId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `TTS 失败 ${res.status}`);
  }
  const ct = res.headers.get("content-type") ?? "audio/wav";
  return { blob: await res.blob(), ext: ct.includes("mpeg") ? "mp3" : "wav" };
}

function playAudioBlob(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    activeAudio = audio;
    const done = () => {
      if (activeAudio === audio) activeAudio = null;
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

/** 逐句合成 + 顺序播放（服务端有缓存，重复播放同一句不再打上游） */
async function speakServer(text: string, characterId?: string, onProgress?: TtsOptions["onProgress"]) {
  const segments = splitSentences(text);
  if (segments.length === 0) return;
  serverCancelled = false;
  for (let i = 0; i < segments.length; i++) {
    if (serverCancelled) return;
    onProgress?.(i + 1, segments.length);
    const { blob } = await fetchTtsBlob(segments[i], characterId);
    if (serverCancelled) return;
    await playAudioBlob(blob);
  }
}

/** 播放单一段（分段面板用；不等播放结束） */
export async function speakSegment(segment: string, opts: TtsOptions = {}): Promise<void> {
  stopSpeak();
  const provider = currentProvider();
  if (provider === "browser") {
    playBrowserTts(segment, opts);
    return;
  }
  serverCancelled = false;
  const { blob } = await fetchTtsBlob(segment, opts.characterId);
  if (!serverCancelled) await playAudioBlob(blob);
}

/** 下载语音文件（server 供应商；长文本请配合分段面板逐段下载） */
export async function downloadTts(text: string, characterId?: string): Promise<void> {
  const { blob, ext } = await fetchTtsBlob(text, characterId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `himuro-tts-${Date.now()}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ------------------------------ browser 供应商 ------------------------------ */

function utterance(text: string, opts: TtsOptions = {}) {
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const picked = opts.voiceURI ? voices.find((v) => v.voiceURI === opts.voiceURI) : undefined;
  if (picked) u.voice = picked;
  u.lang = picked?.lang || "zh-CN";
  u.rate = opts.rate ?? 1;
  u.pitch = opts.pitch ?? 1;
  return u;
}

function playBrowserTts(text: string, opts: TtsOptions = {}) {
  if (!ttsSupported()) throw new Error("此浏览器不支持 Web Speech API");
  speechSynthesis.cancel();
  // 长文本按句排队，浏览器逐句朗读（语调比整段自然）
  for (const seg of splitSentences(text)) speechSynthesis.speak(utterance(seg, opts));
}

/* -------------------------------- 统一入口 -------------------------------- */

/** 统一入口：按当前供应商朗读。characterId 传入时服务端优先用该角色自己的音色配置 */
export async function speak(text: string, opts: TtsOptions = {}): Promise<"browser" | "server"> {
  const provider = currentProvider();
  if (provider === "browser") {
    playBrowserTts(text, opts);
    return "browser";
  }
  await speakServer(text, opts.characterId, opts.onProgress);
  return "server";
}

export function stopSpeak() {
  serverCancelled = true;
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
  if (ttsSupported()) speechSynthesis.cancel();
}
