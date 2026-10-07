"use client";

import { splitSentences } from "@/lib/ttsText";
import type { TtsProvider } from "@/lib/settings";

/**
 * TTS 客户端统一入口。三种供应商：
 * - browser：Web Speech API（零依赖离线），音色/语速/音调可调，长文本按句排队
 * - gptsovits / openai：走服务端 /api/tts 代理（服务端有磁盘缓存 + 语速合并），
 *   长文本逐句合成、顺序播放，可随时停止/被下一次朗读抢占
 *
 * 供应商参数保存在设置页（SQLite），同时同步一份到 localStorage，
 * 聊天页试听时据此选择链路（避免每条消息多一次配置请求）。
 *
 * 同一时刻只允许一段音频在响：新的朗读先掐掉上一段，连在路上的合成请求一起 abort，
 * GPT-SoVITS 合成慢（冷启动可到十几秒），不这么做连点两条消息就会叠着播。
 */

export type TtsOptions = {
  voiceURI?: string;
  rate?: number;
  pitch?: number;
  characterId?: string;
  /** 逐段播放进度回调（server 供应商长文本时触发） */
  onProgress?: (index: number, total: number) => void;
};

export type SpeechAudio = { blob: Blob; ext: "wav" | "mp3" };

/**
 * 向服务端代理要一段音频，不播放。试听/分段面板/导出配音共用同一个入口，
 * 语速交给服务端（GPT-SoVITS 的 speed_factor / OpenAI 的 speed），角色级配置在那边合并。
 */
export async function fetchSpeech(
  text: string,
  opts: { characterId?: string; rate?: number; signal?: AbortSignal } = {},
): Promise<SpeechAudio> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      characterId: opts.characterId,
      speed: Number.isFinite(opts.rate) ? opts.rate : undefined,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `TTS 失败 ${res.status}`);
  }
  const blob = await res.blob();
  const ct = res.headers.get("content-type") ?? "";
  return { blob, ext: ct.includes("mpeg") || ct.includes("mp3") ? "mp3" : "wav" };
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

/* ------------------------------ server 供应商 ------------------------------ */

/** 模块级单例：当前在播的音频、它的 objectURL、以及还没回来的那次合成请求 */
let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let currentAbort: AbortController | null = null;
/** 朗读代次：每次新的朗读/停止 +1；逐段队列见到代次变了就自己退出 */
let speakToken = 0;

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

function playAudioBlob(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    currentUrl = url;
    const done = () => {
      if (currentAudio === audio) releaseServerAudio();
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

/** 逐句合成 + 顺序播放（服务端有缓存，重复播放同一句不再打上游） */
async function speakServer(
  text: string,
  characterId?: string,
  onProgress?: TtsOptions["onProgress"],
  rate?: number,
) {
  const segments = splitSentences(text);
  if (segments.length === 0) return;
  const token = ++speakToken;
  releaseServerAudio(); // 掐掉上一段还没响完的/在路上的
  for (let i = 0; i < segments.length; i++) {
    if (token !== speakToken) return;
    onProgress?.(i + 1, segments.length);
    const abort = new AbortController();
    currentAbort = abort;
    let audio: SpeechAudio;
    try {
      audio = await fetchSpeech(segments[i], { characterId, rate, signal: abort.signal });
    } catch (err) {
      // 被新的朗读/停止 abort 掉属于正常抢占，不当错误上报
      if (err instanceof DOMException && err.name === "AbortError") return;
      throw err;
    }
    if (token !== speakToken) return;
    await playAudioBlob(audio.blob);
    if (token !== speakToken) return;
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
  const { blob } = await fetchSpeech(segment, { characterId: opts.characterId, rate: opts.rate });
  await playAudioBlob(blob);
}

/** 下载语音文件（server 供应商；长文本请配合分段面板逐段下载） */
export async function downloadTts(
  text: string,
  characterId?: string,
  rate?: number,
): Promise<void> {
  const { blob, ext } = await fetchSpeech(text, { characterId, rate });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `himuro-tts-${Date.now()}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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

/** 统一入口：按当前供应商朗读。characterId 传入时服务端优先用该角色自己的音色/语速配置 */
export async function speak(text: string, opts: TtsOptions = {}): Promise<"browser" | "server"> {
  const provider = currentProvider();
  if (provider === "browser") {
    releaseServerAudio(); // 换到浏览器音色时，别让上一条服务端音频还在响
    playBrowserTts(text, opts);
    return "browser";
  }
  await speakServer(text, opts.characterId, opts.onProgress, opts.rate);
  return "server";
}

/** 停掉一切语音：浏览器合成、服务端在播音频与在途请求全停 */
export function stopSpeak() {
  speakToken++;
  if (ttsSupported()) speechSynthesis.cancel();
  releaseServerAudio();
}
