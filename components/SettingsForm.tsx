"use client";

import { useEffect, useState, useTransition } from "react";
import { saveSettingsAction, testModelConfig } from "@/lib/actions";
import { getChineseVoices, speak, stopSpeak } from "@/lib/tts";
import type { ModelConfig } from "@/lib/types";
import { btnGhost, btnPrimary, card, input, label } from "@/lib/ui";

type Settings = {
  light: ModelConfig;
  quality: ModelConfig;
  embed: ModelConfig;
  summaryEveryTurns: number;
  wbMaxHits: number;
  vecTopK: number;
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
};

const TIER_INFO = {
  light: { title: "轻量档", hint: "响应快、成本低：日常闲聊、试设定阶段用" },
  quality: { title: "高质量档", hint: "细节与情绪更好：剧情推进、沉浸扮演用" },
} as const;

export default function SettingsForm({ initial }: { initial: Settings }) {
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; reply: string }>>({});
  const [voices, setVoices] = useState<{ uri: string; name: string }[]>([]);

  useEffect(() => {
    const load = () => setVoices(getChineseVoices());
    load();
    if (typeof speechSynthesis !== "undefined") {
      speechSynthesis.addEventListener("voiceschanged", load);
      return () => speechSynthesis.removeEventListener("voiceschanged", load);
    }
  }, []);

  function setModel(key: "light" | "quality" | "embed", field: keyof ModelConfig, v: string) {
    setForm((f) => ({ ...f, [key]: { ...f[key], [field]: v } }));
  }

  function save() {
    startTransition(async () => {
      await saveSettingsAction(form);
      // TTS 参数同步给聊天页（Web Speech API 只在浏览器端可用）
      localStorage.setItem("himuro-tts-voice", form.ttsVoice);
      localStorage.setItem("himuro-tts-rate", String(form.ttsRate));
      localStorage.setItem("himuro-tts-pitch", String(form.ttsPitch));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  function test(key: "light" | "quality") {
    startTransition(async () => {
      setTestResult((t) => ({ ...t, [key]: { ok: false, reply: "测试中…" } }));
      const r = await testModelConfig(key);
      setTestResult((t) => ({ ...t, [key]: r }));
    });
  }

  const modelCard = (key: "light" | "quality" | "embed") => {
    const info = key !== "embed" ? TIER_INFO[key] : null;
    return (
      <section className={card + " p-5"} key={key}>
        <div className="mb-3 flex items-center">
          <h2 className="font-semibold">{info ? info.title : "Embedding（向量记忆，可选）"}</h2>
          {info && <span className="ml-2 text-xs text-zinc-400">{info.hint}</span>}
          {key === "embed" && (
            <span className="ml-2 text-xs text-zinc-400">留空则停用向量检索，关键词+摘要仍然工作</span>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className={label}>Base URL（OpenAI 兼容，填 mock 用演示模型）</label>
            <input
              className={input}
              value={form[key].baseUrl}
              onChange={(e) => setModel(key, "baseUrl", e.target.value)}
              placeholder={key === "embed" ? "https://open.bigmodel.cn/api/paas/v4" : "mock 或 https://…"}
            />
          </div>
          <div>
            <label className={label}>API Key（本地存储，不出本机）</label>
            <input
              type="password"
              className={input}
              value={form[key].apiKey}
              onChange={(e) => setModel(key, "apiKey", e.target.value)}
              placeholder="sk-…"
            />
          </div>
          <div>
            <label className={label}>模型名</label>
            <input
              className={input}
              value={form[key].model}
              onChange={(e) => setModel(key, "model", e.target.value)}
              placeholder={key === "light" ? "glm-4-flash" : key === "quality" ? "glm-4-plus" : "embedding-3"}
            />
          </div>
        </div>
        {key !== "embed" && (
          <div className="mt-3 flex items-center gap-2">
            <button className={btnGhost + " text-xs"} disabled={pending} onClick={() => test(key)}>
              测试连接
            </button>
            {testResult[key] && (
              <span className={"text-xs " + (testResult[key].ok ? "text-emerald-600" : "text-red-500")}>
                {testResult[key].ok ? "✓ " : "✗ "}
                {testResult[key].reply}
              </span>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex items-center">
        <h1 className="text-lg font-bold">设置</h1>
        <button className={btnPrimary + " ml-auto"} disabled={pending} onClick={save}>
          {pending ? "保存中…" : saved ? "✓ 已保存" : "保存全部设置"}
        </button>
      </div>

      {modelCard("light")}
      {modelCard("quality")}
      {modelCard("embed")}

      <section className={card + " p-5"}>
        <h2 className="mb-3 font-semibold">记忆参数</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className={label}>每累计 N 条消息做一次滚动摘要</label>
            <input
              type="number"
              min={4}
              max={40}
              className={input}
              value={form.summaryEveryTurns}
              onChange={(e) => setForm((f) => ({ ...f, summaryEveryTurns: Number(e.target.value) || 10 }))}
            />
          </div>
          <div>
            <label className={label}>世界书单轮最大注入条数</label>
            <input
              type="number"
              min={1}
              max={20}
              className={input}
              value={form.wbMaxHits}
              onChange={(e) => setForm((f) => ({ ...f, wbMaxHits: Number(e.target.value) || 6 }))}
            />
          </div>
          <div>
            <label className={label}>向量检索注入条数</label>
            <input
              type="number"
              min={0}
              max={10}
              className={input}
              value={form.vecTopK}
              onChange={(e) => setForm((f) => ({ ...f, vecTopK: Number(e.target.value) || 0 }))}
            />
          </div>
        </div>
      </section>

      <section className={card + " p-5"}>
        <h2 className="mb-1 font-semibold">语音（TTS）</h2>
        <p className="mb-3 text-xs text-zinc-400">
          v1 使用浏览器内置语音：先选接近角色气质的基底音色，再微调语速/音调；在聊天页点消息的「▶ 试听」即可朗读。
          自部署 TTS（GPT-SoVITS / CosyVoice）为后续版本。
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className={label}>基底音色（中文）</label>
            <select
              className={input}
              value={form.ttsVoice}
              onChange={(e) => setForm((f) => ({ ...f, ttsVoice: e.target.value }))}
            >
              <option value="">系统默认</option>
              {voices.map((v) => (
                <option key={v.uri} value={v.uri}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>语速 {form.ttsRate.toFixed(1)}x</label>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={form.ttsRate}
              className="w-full accent-indigo-600"
              onChange={(e) => setForm((f) => ({ ...f, ttsRate: Number(e.target.value) }))}
            />
          </div>
          <div>
            <label className={label}>音调 {form.ttsPitch.toFixed(1)}</label>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={form.ttsPitch}
              className="w-full accent-indigo-600"
              onChange={(e) => setForm((f) => ({ ...f, ttsPitch: Number(e.target.value) }))}
            />
          </div>
        </div>
        <button
          className={btnGhost + " mt-3 text-xs"}
          onClick={() => {
            stopSpeak();
            speak("你好呀，我是你要找的那个声音。以后的日子里，也请多指教了。", {
              voiceURI: form.ttsVoice || undefined,
              rate: form.ttsRate,
              pitch: form.ttsPitch,
            });
          }}
        >
          ▶ 试听
        </button>
      </section>
    </div>
  );
}
