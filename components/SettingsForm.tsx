"use client";

import { useEffect, useState, useTransition } from "react";
import {
  clearTtsCacheAction,
  saveSettingsAction,
  testModelConfig,
  ttsCacheInfoAction,
} from "@/lib/actions";
import { getChineseVoices, speak } from "@/lib/tts";
import type { AppSettings, TtsProvider } from "@/lib/settings";
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
  tts: AppSettings["tts"];
};

const TTS_PROVIDER_LABEL: Record<TtsProvider, string> = {
  browser: "浏览器内置（离线可用）",
  gptsovits: "GPT-SoVITS（api_v2）",
  openai: "OpenAI 兼容 /audio/speech",
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
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsError, setTtsError] = useState("");
  const [ttsHint, setTtsHint] = useState("");
  const [cacheInfo, setCacheInfo] = useState<{ files: number; bytes: number } | null>(null);
  const [restoreMsg, setRestoreMsg] = useState("");

  useEffect(() => {
    ttsCacheInfoAction().then(setCacheInfo).catch(() => setCacheInfo({ files: 0, bytes: 0 }));
  }, []);

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

  function setTts(field: keyof Settings["tts"], v: string) {
    setForm((f) => ({ ...f, tts: { ...f.tts, [field]: v } }));
  }

  function save() {
    startTransition(async () => {
      await saveSettingsAction(form);
      // TTS 参数同步给聊天页（试听时据此选择链路）
      localStorage.setItem("himuro-tts-provider", form.tts.provider);
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

  function restoreBackup(file: File) {
    if (!confirm("恢复会覆盖现有全部数据（角色/世界书/会话/消息/设置），确定继续？")) return;
    startTransition(async () => {
      try {
        const json = JSON.parse(await file.text());
        const res = await fetch("/api/backup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(json),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setRestoreMsg(
          "已恢复：" + Object.entries(data.counts as Record<string, number>).map(([k, v]) => `${k} ${v} 条`).join("，"),
        );
      } catch (e) {
        setRestoreMsg(e instanceof Error ? e.message : "恢复失败");
      }
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
          浏览器内置 = 零依赖离线朗读；GPT-SoVITS = 自部署 api_v2（按参考音频克隆音色）；OpenAI 兼容 = 任意实现 /audio/speech 的服务。
          服务端代理走 /api/tts，内网地址不暴露给页面。
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className={label}>供应商</label>
            <select
              className={input}
              value={form.tts.provider}
              onChange={(e) => setTts("provider", e.target.value)}
            >
              {(Object.keys(TTS_PROVIDER_LABEL) as TtsProvider[]).map((p) => (
                <option key={p} value={p}>
                  {TTS_PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {form.tts.provider === "gptsovits" && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className={label}>Base URL（如 http://127.0.0.1:9880）</label>
                <input className={input} value={form.tts.baseUrl} onChange={(e) => setTts("baseUrl", e.target.value)} />
              </div>
              <div>
                <label className={label}>合成语言 text_lang（zh / ja / en / auto）</label>
                <input className={input} value={form.tts.lang} onChange={(e) => setTts("lang", e.target.value)} />
              </div>
            </div>
            <div>
              <label className={label}>参考音频路径（服务端文件路径，决定音色）</label>
              <input className={input} value={form.tts.refAudio} onChange={(e) => setTts("refAudio", e.target.value)} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className={label}>参考音频说的话（prompt_text）</label>
                <textarea
                  className={input + " min-h-16"}
                  value={form.tts.promptText}
                  onChange={(e) => setTts("promptText", e.target.value)}
                />
              </div>
              <div>
                <label className={label}>参考音频语言 prompt_lang（ja / zh / en）</label>
                <input className={input} value={form.tts.promptLang} onChange={(e) => setTts("promptLang", e.target.value)} />
                <p className="mt-2 text-xs text-zinc-400">
                  提示：在 WSL 里跑 <code>bash ~/GPT-SoVITS/start_api.sh</code> 启动服务。
                </p>
              </div>
            </div>
          </div>
        )}

        {form.tts.provider === "openai" && (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div>
              <label className={label}>Base URL（如 http://127.0.0.1:50000/v1）</label>
              <input className={input} value={form.tts.baseUrl} onChange={(e) => setTts("baseUrl", e.target.value)} />
            </div>
            <div>
              <label className={label}>模型名</label>
              <input className={input} value={form.tts.model} onChange={(e) => setTts("model", e.target.value)} placeholder="cosyvoice-v2" />
            </div>
            <div>
              <label className={label}>音色 voice</label>
              <input className={input} value={form.tts.voice} onChange={(e) => setTts("voice", e.target.value)} placeholder="alloy" />
            </div>
          </div>
        )}

        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div>
            <label className={label}>语速 {form.ttsRate.toFixed(2)}x</label>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={form.ttsRate}
              className="w-full accent-indigo-600"
              onChange={(e) => setForm((f) => ({ ...f, ttsRate: Number(e.target.value) }))}
            />
            <p className="mt-1 text-xs text-zinc-400">
              三条链路通用；自部署档会夹到实测有效区间 0.6–1.65，角色卡里还能再单独覆盖
            </p>
          </div>

          {form.tts.provider === "browser" && (
            <>
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
                <p className="mt-1 text-xs text-zinc-400">仅浏览器内置语音支持</p>
              </div>
            </>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            className={btnGhost + " text-xs"}
            disabled={ttsTesting}
            onClick={async () => {
              setTtsTesting(true);
              setTtsError("");
              try {
                // 试听永远走「保存前的当前表单链路」：先按当前表单值更新 localStorage
                localStorage.setItem("himuro-tts-provider", form.tts.provider);
                const used = await speak(
                  "你好呀，我是你要找的那个声音。以后的日子里，也请多指教了。",
                  { voiceURI: form.ttsVoice || undefined, rate: form.ttsRate, pitch: form.ttsPitch },
                );
                if (used === "server") setTtsHint("已请求服务端合成，稍候即播");
              } catch (e) {
                setTtsError(e instanceof Error ? e.message : "TTS 失败");
              } finally {
                setTtsTesting(false);
              }
            }}
          >
            ▶ 试听
          </button>
          {ttsTesting && <span className="text-xs text-zinc-400">合成中…（自部署模型首次合成较慢）</span>}
          {ttsHint && <span className="text-xs text-emerald-600">{ttsHint}</span>}
          {ttsError && <span className="text-xs text-red-500">{ttsError}</span>}
        </div>

        <div className="mt-3 flex items-center gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-400">
          <span>
            语音缓存：
            {cacheInfo
              ? `${cacheInfo.files} 个文件 / ${(cacheInfo.bytes / 1024 / 1024).toFixed(1)} MB（200 MB 上限，超限自动清最旧）`
              : "统计中…"}
          </span>
          <button
            className="ml-auto text-zinc-400 hover:text-red-500 disabled:opacity-40"
            disabled={pending || !cacheInfo || cacheInfo.files === 0}
            onClick={() =>
              startTransition(async () => {
                await clearTtsCacheAction();
                setCacheInfo(await ttsCacheInfoAction());
              })
            }
          >
            清空语音缓存
          </button>
        </div>
      </section>

      <section className={card + " p-5"}>
        <h2 className="mb-1 font-semibold">数据管理</h2>
        <p className="mb-3 text-xs text-zinc-400">
          全库备份 = 9 张表全量 JSON（角色 / 世界书 / 会话 / 消息 / 向量 / 设置…）；恢复会覆盖现有全部数据，操作前请先导出一份。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <a className={btnGhost + " text-xs"} href="/api/backup">
            导出全库备份
          </a>
          <label className={btnGhost + " cursor-pointer text-xs"}>
            恢复备份
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) restoreBackup(f);
                e.target.value = "";
              }}
            />
          </label>
          {restoreMsg && <span className="text-xs text-zinc-500">{restoreMsg}</span>}
        </div>
      </section>
    </div>
  );
}
