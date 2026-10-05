"use client";

/**
 * TTS v1（浏览器 Web Speech API）：基底音色选择 + 语速/音调微调 + 试听。
 * 满足风月「选基底音色 → 单参数微调 → 试听」的工作流；自部署 TTS
 * （GPT-SoVITS / CosyVoice）为 Phase 2，接入时替换本模块即可。
 */

export type TtsOptions = { voiceURI?: string; rate?: number; pitch?: number };

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** 中文语音列表（Windows 自带 Microsoft Xiaoxiao/Huihui 等） */
export function getChineseVoices(): { uri: string; name: string }[] {
  if (!ttsSupported()) return [];
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith("zh"))
    .map((v) => ({ uri: v.voiceURI, name: `${v.name} (${v.lang})` }));
}

export function speak(text: string, opts: TtsOptions = {}) {
  if (!ttsSupported() || !text.trim()) return;
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

export function stopSpeak() {
  if (ttsSupported()) speechSynthesis.cancel();
}
