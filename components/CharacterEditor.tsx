"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createCharacter, updateCharacter } from "@/lib/actions";
import { speak, stopSpeak } from "@/lib/tts";
import type { CharacterCard, Example, HimuroCardFile } from "@/lib/types";
import { btnGhost, btnPrimary, card, input, label, textarea } from "@/lib/ui";

const COLORS = ["#6366f1", "#f472b6", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#f87171"];
const EMOJIS = ["🙂", "🌷", "⚡", "🗡️", "🌙", "🐱", "☕", "🎧", "❄️", "🌸"];

export default function CharacterEditor({
  initial,
  worldbookCharacterId,
  hasWorldbook,
}: {
  initial: Omit<CharacterCard, "isTemplate">;
  worldbookCharacterId: string;
  hasWorldbook: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isNew = initial.id === "__new__";
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsMsg, setTtsMsg] = useState("");

  const set = (key: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  function save() {
    setError("");
    setSaved(false);
    startTransition(async () => {
      try {
        if (isNew) {
          const { id } = await createCharacter({ ...form }, true);
          router.replace(`/characters/${id}`);
        } else {
          await updateCharacter(form.id, { ...form });
        }
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function exportJson() {
    const payload: HimuroCardFile = {
      format: "himuro-card",
      version: 1,
      card: {
        name: form.name,
        emoji: form.emoji,
        color: form.color,
        identity: form.identity,
        speechStyle: form.speechStyle,
        values: form.values,
        boundaries: form.boundaries,
        userAddressing: form.userAddressing,
        relationship: form.relationship,
        firstMessage: form.firstMessage,
        examples: form.examples,
        ttsRefAudio: form.ttsRefAudio,
        ttsPromptText: form.ttsPromptText,
        ttsPromptLang: form.ttsPromptLang,
        ttsLang: form.ttsLang,
        ttsRate: form.ttsRate,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `himuro-card-${form.name || "untitled"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** 可选底图（PNG dataURL）；不选则服务端用角色色渐变底图 */
  const [baseImage, setBaseImage] = useState<string | null>(null);

  async function exportPng() {
    setError("");
    try {
      const res = await fetch("/api/export/card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: form.id, baseImage: baseImage ?? undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? "导出失败");
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${form.name || "card"}-SillyTavern卡.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const setExample = (i: number, key: keyof Example, v: string) =>
    setForm((f) => ({
      ...f,
      examples: f.examples.map((e, idx) => (idx === i ? { ...e, [key]: v } : e)),
    }));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">{isNew ? "新建角色" : `编辑角色 · ${form.name}`}</h1>
        <div className="ml-auto flex flex-wrap gap-2">
          {!isNew && hasWorldbook && (
            <Link href={`/worldbooks/${worldbookCharacterId}`} className={btnGhost}>
              世界书 →
            </Link>
          )}
          {!isNew && (
            <button className={btnGhost} onClick={exportJson}>
              导出角色卡
            </button>
          )}
          {!isNew && (
            <button className={btnGhost} onClick={exportPng} title="SillyTavern 通用格式：卡 JSON 写进 PNG 的 tEXt 块">
              导出 ST 卡 PNG
            </button>
          )}
          {!isNew && (
            <label className={btnGhost + " cursor-pointer"} title="可选：指定一张 PNG 作为卡面底图">
              底图{baseImage ? " ✓" : ""}
              <input
                type="file"
                accept="image/png"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return setBaseImage(null);
                  const reader = new FileReader();
                  reader.onload = () => setBaseImage(reader.result as string);
                  reader.readAsDataURL(file);
                }}
              />
            </label>
          )}
          <button className={btnPrimary} disabled={pending} onClick={save}>
            {pending ? "保存中…" : saved ? "✓ 已保存" : "保存"}
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* 外观 */}
      <section className={card + " p-5"}>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className={label}>名字</label>
            <input className={input + " w-44"} value={form.name} onChange={(e) => set("name")(e.target.value)} />
          </div>
          <div>
            <label className={label}>头像 emoji</label>
            <div className="flex flex-wrap gap-1">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => set("emoji")(e)}
                  className={
                    "h-8 w-8 rounded-lg text-lg transition " +
                    (form.emoji === e ? "bg-indigo-100 ring-2 ring-indigo-300" : "hover:bg-zinc-100")
                  }
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={label}>主题色</label>
            <div className="flex gap-1">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => set("color")(c)}
                  style={{ backgroundColor: c }}
                  className={
                    "h-7 w-7 rounded-full transition " +
                    (form.color === c ? "ring-2 ring-zinc-400 ring-offset-2" : "")
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 五件套 */}
      <section className={card + " p-5"}>
        <h2 className="mb-1 font-semibold">角色卡五件套</h2>
        <p className="mb-4 text-xs text-zinc-400">风月口径：一句话定位，不堆形容词；样例对话比长篇散文更能锁语感。</p>
        <div className="flex flex-col gap-4">
          <div>
            <label className={label}>① 身份一句话</label>
            <textarea className={textarea} value={form.identity} onChange={(e) => set("identity")(e.target.value)} placeholder="你是「××」，用户的……，特点是……" />
          </div>
          <div>
            <label className={label}>② 说话方式（语气 / 口癖）</label>
            <textarea className={textarea} value={form.speechStyle} onChange={(e) => set("speechStyle")(e.target.value)} placeholder="句式、口头禅、生气时会怎么说话……" />
          </div>
          <div>
            <label className={label}>③ 价值观</label>
            <textarea className={textarea} value={form.values} onChange={(e) => set("values")(e.target.value)} placeholder="TA 相信什么、在意什么、讨厌什么" />
          </div>
          <div>
            <label className={label}>④ 禁忌边界（会写入 system，模型必须遵守）</label>
            <textarea className={textarea} value={form.boundaries} onChange={(e) => set("boundaries")(e.target.value)} placeholder="不谈论……；绝不……" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className={label}>⑤ 对用户的称呼习惯</label>
              <input className={input} value={form.userAddressing} onChange={(e) => set("userAddressing")(e.target.value)} placeholder="平时叫……，认真时叫……" />
            </div>
            <div>
              <label className={label}>与用户的关系</label>
              <input className={input} value={form.relationship} onChange={(e) => set("relationship")(e.target.value)} placeholder="青梅竹马 / 同班同学 / 初识旅伴……" />
            </div>
          </div>
          <div>
            <label className={label}>开场白（新建会话时 TA 说的第一句话）</label>
            <textarea className={textarea} value={form.firstMessage} onChange={(e) => set("firstMessage")(e.target.value)} placeholder="（动作/场景）「台词……」" />
          </div>
        </div>
      </section>

      {/* 示例对话 */}
      <section className={card + " p-5"}>
        <div className="mb-1 flex items-center">
          <h2 className="font-semibold">示例对话（3–5 组，锁定语感）</h2>
          <button
            className={btnGhost + " ml-auto"}
            disabled={form.examples.length >= 5}
            onClick={() => setForm((f) => ({ ...f, examples: [...f.examples, { user: "", assistant: "" }] }))}
          >
            ＋ 加一组
          </button>
        </div>
        <p className="mb-4 text-xs text-zinc-400">口语化、贴近真实聊天；超过 5 组会自动淘汰最早的一组（回写时同理）。</p>
        <div className="flex flex-col gap-4">
          {form.examples.map((ex, i) => (
            <div key={i} className="rounded-xl border border-zinc-100 bg-zinc-50 p-3">
              <div className="mb-2 flex items-center text-xs font-medium text-zinc-400">
                示例 {i + 1}
                <button
                  className="ml-auto text-red-400 hover:text-red-600"
                  onClick={() => setForm((f) => ({ ...f, examples: f.examples.filter((_, idx) => idx !== i) }))}
                >
                  移除
                </button>
              </div>
              <label className={label}>用户说</label>
              <textarea className={textarea + " min-h-12"} value={ex.user} onChange={(e) => setExample(i, "user", e.target.value)} />
              <label className={label + " mt-2"}>{form.name || "角色"}回</label>
              <textarea className={textarea + " min-h-16"} value={ex.assistant} onChange={(e) => setExample(i, "assistant", e.target.value)} />
            </div>
          ))}
          {form.examples.length === 0 && (
            <p className="text-sm text-zinc-400">还没有示例。建议至少写 3 组，聊天页里也可把满意的对话一键回写成示例。</p>
          )}
        </div>
      </section>

      {/* 角色语音 */}
      <section className={card + " p-5"}>
        <h2 className="mb-1 font-semibold">角色语音（可选）</h2>
        <p className="mb-4 text-xs text-zinc-400">
          供应商为 GPT-SoVITS 时，参考音频即音色：为本角色填一段 TA 的参考音频（服务端路径）即可专属声线；
          留空则使用设置页的全局音色。浏览器内置语音不支持按角色区分。
        </p>
        <div className="flex flex-col gap-4">
          <div>
            <label className={label}>参考音频路径（服务端文件路径，如 /home/miku/GPT-SoVITS/…/xxx.wav）</label>
            <input className={input} value={form.ttsRefAudio} onChange={(e) => set("ttsRefAudio")(e.target.value)} />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className={label}>参考音频说的话（prompt_text，日语/中文原文）</label>
              <textarea className={textarea + " min-h-16"} value={form.ttsPromptText} onChange={(e) => set("ttsPromptText")(e.target.value)} />
            </div>
            <div className="flex flex-col gap-4">
              <div>
                <label className={label}>参考音频语言</label>
                <input className={input} value={form.ttsPromptLang} onChange={(e) => set("ttsPromptLang")(e.target.value)} placeholder="ja / zh / en" />
              </div>
              <div>
                <label className={label}>合成语言</label>
                <input className={input} value={form.ttsLang} onChange={(e) => set("ttsLang")(e.target.value)} placeholder="zh / ja / en（留空=全局）" />
              </div>
              <div>
                <label className={label}>
                  语速 {form.ttsRate > 0 ? `${form.ttsRate.toFixed(2)}x` : "（跟随全局）"}
                </label>
                <input
                  className={input}
                  type="number"
                  min={0}
                  max={1.65}
                  step={0.05}
                  value={form.ttsRate}
                  onChange={(e) => setForm((f) => ({ ...f, ttsRate: Number(e.target.value) || 0 }))}
                  title="0 = 跟随设置页的全局语速；GPT-SoVITS 实测有效区间 0.6~1.65"
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={btnGhost + " text-xs"}
              disabled={ttsBusy || isNew}
              title={isNew ? "先保存角色后再试听" : "先保存当前修改，再用该角色音色试听"}
              onClick={async () => {
                setTtsBusy(true);
                setTtsMsg("");
                try {
                  // 先落库，确保服务端读到最新配置
                  if (isNew) throw new Error("先保存角色后再试听");
                  await updateCharacter(form.id, { ...form });
                  stopSpeak();
                  const used = await speak(`${form.name}的专属音色试听。这是从角色卡里发出的声音。`, {
                    characterId: form.id,
                  });
                  setTtsMsg(used === "server" ? "已请求服务端合成" : "当前为浏览器内置语音，无法区分角色");
                } catch (e) {
                  setTtsMsg(e instanceof Error ? e.message : "TTS 失败");
                } finally {
                  setTtsBusy(false);
                }
              }}
            >
              ▶ 用此音色试听
            </button>
            {ttsBusy && <span className="text-xs text-zinc-400">合成中…</span>}
            {ttsMsg && <span className="text-xs text-zinc-500">{ttsMsg}</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
