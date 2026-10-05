"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  addConversationMember,
  deleteMessage,
  editUserMessageAndTruncate,
  removeConversationMember,
  saveEntryForCharacter,
  toggleStar,
  updateConversation,
  writeBackExample,
} from "@/lib/actions";
import { generateHook, distillWorldbookDraft } from "@/lib/story";
import { speak, stopSpeak } from "@/lib/tts";
import {
  EMOTION_PRESETS,
  GROUP_STRATEGY_LABEL,
  MODE_LABEL,
  TIER_LABEL,
  type CharacterCard,
  type GroupStrategy,
  type Mode,
  type Tier,
  type WbCategory,
} from "@/lib/types";
import { badge, btnGhost, btnPrimary, card, input } from "@/lib/ui";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  characterId?: string | null;
  emotion: string | null;
  starred: boolean;
};

type Member = { id: string; name: string; emoji: string; color: string };

type Conv = {
  id: string;
  title: string;
  mode: Mode;
  tier: Tier;
  chapter: number;
  summary: string;
  groupStrategy: GroupStrategy | null;
};

type Hit = { category: string; title: string; weight: number };
type Draft = { category: string; title: string; content: string; keywords: string[]; weight: number };
type Speaker = { characterId: string; name: string; emoji: string };

function lastAssistantId(list: Msg[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === "assistant") return list[i].id;
  return null;
}

export default function ChatRoom({
  conversation,
  character,
  members,
  isGroup,
  allCharacters,
  initialMessages,
}: {
  conversation: Conv;
  character: CharacterCard;
  members: Member[];
  isGroup: boolean;
  allCharacters: Member[];
  initialMessages: Msg[];
}) {
  const [conv, setConv] = useState(conversation);
  const [msgs, setMsgs] = useState<Msg[]>(initialMessages);
  const [inputVal, setInputVal] = useState("");
  const [emotion, setEmotion] = useState<string | null>(null);
  const [streaming, setStreaming] = useState("");
  const [currentSpeaker, setCurrentSpeaker] = useState<Speaker | null>(null);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<{ speaker?: string; hits: Hit[] }>({ hits: [] });
  const [summary, setSummary] = useState(conversation.summary);
  const [hook, setHook] = useState("");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [pending, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, streaming]);

  function flash(text: string) {
    setNotice(text);
    setTimeout(() => setNotice(""), 2500);
  }

  /* ---------------------------- SSE 流式公共流程 ---------------------------- */
  // 群聊一轮会有多个发言者：每个 speaker 的文本通过 speaker_done 先行落库/上屏，
  // done 事件只负责收尾（摘要 + 用户消息真实 id）。单聊则由 done 追加唯一的回复。
  async function runStream(
    payload: { content?: string; emotion?: string | null; reroll?: boolean; rerollMessageId?: string },
  ): Promise<{ messageId: string; userMessageId?: string; text: string; summary?: string; appendedBySpeaker: boolean }> {
    setBusy(true);
    let appendedBySpeaker = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id, ...payload }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "请求失败" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      let speakerAcc = "";
      let done: { messageId: string; userMessageId?: string; summary?: string } | null = null;
      while (true) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          const line = block.trim();
          if (!line.startsWith("data:")) continue;
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.t === "hits") {
            setHits({ speaker: evt.speaker, hits: evt.hits });
          } else if (evt.t === "speaker") {
            setCurrentSpeaker({ characterId: evt.characterId, name: evt.name, emoji: evt.emoji });
            speakerAcc = "";
          } else if (evt.t === "tok") {
            acc += evt.v;
            speakerAcc += evt.v;
            setStreaming(speakerAcc);
          } else if (evt.t === "speaker_done") {
            // 注意：React 的 updater 是延迟执行的，必须先把 speakerAcc 快照成常量，
            // 否则下面紧跟着的清零会把 updater 闭包里读到的内容变成空串
            const spokenText = speakerAcc;
            const spokenById = evt.characterId;
            setMsgs((m) => [
              ...m,
              {
                id: evt.messageId,
                role: "assistant",
                content: spokenText,
                characterId: spokenById,
                emotion: null,
                starred: false,
              },
            ]);
            appendedBySpeaker = true;
            speakerAcc = "";
            setCurrentSpeaker(null);
          } else if (evt.t === "done") {
            done = evt;
          } else if (evt.t === "err") {
            throw new Error(evt.message);
          }
        }
      }
      if (!done) throw new Error("回复流中断");
      return {
        messageId: done.messageId,
        userMessageId: done.userMessageId,
        text: acc,
        summary: done.summary,
        appendedBySpeaker,
      };
    } finally {
      setStreaming("");
      setCurrentSpeaker(null);
      setBusy(false);
    }
  }

  /* ------------------------------- 发送消息 ------------------------------- */
  async function send() {
    const content = inputVal.trim();
    if (!content || busy) return;
    setInputVal("");
    const tmpId = `tmp-user-${Date.now()}`;
    setMsgs((m) => [...m, { id: tmpId, role: "user", content, emotion, starred: false }]);
    try {
      const r = await runStream({ content, emotion });
      setMsgs((m) => [
        ...m.map((x) =>
          x.id === tmpId ? { ...x, id: r.userMessageId ?? `u-${Date.now()}` } : x,
        ),
        ...(r.appendedBySpeaker
          ? []
          : [
              {
                id: r.messageId,
                role: "assistant" as const,
                content: r.text,
                characterId: null,
                emotion: null,
                starred: false,
              },
            ]),
      ]);
      if (r.summary) setSummary(r.summary);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
      setMsgs((m) => m.map((x) => (x.id === tmpId ? { ...x, id: `u-${Date.now()}` } : x)));
    }
    setEmotion(null);
  }

  /* ------------------------- 重Roll：重新生成回复 ------------------------- */
  async function reroll(messageId?: string) {
    if (busy) return;
    const target = messageId ?? lastAssistantId(msgs);
    if (!target) return;
    setMsgs((m) => m.filter((x) => x.id !== target)); // 乐观移除旧回复
    try {
      const r = await runStream({ reroll: true, rerollMessageId: target });
      if (!r.appendedBySpeaker) {
        setMsgs((m) => [
          ...m,
          { id: r.messageId, role: "assistant", content: r.text, characterId: null, emotion: null, starred: false },
        ]);
      }
      if (r.summary) setSummary(r.summary);
    } catch (e) {
      flash(e instanceof Error ? e.message : "重Roll失败");
    }
  }

  /* ---------------------- 编辑用户消息 → 截断 → 重生成 ---------------------- */
  function startEdit(m: Msg) {
    setEditingId(m.id);
    setEditText(m.content);
  }

  async function saveEdit() {
    if (!editingId || busy) return;
    const id = editingId;
    setEditingId(null);
    try {
      await editUserMessageAndTruncate(id, editText);
      const idx = msgs.findIndex((x) => x.id === id);
      setMsgs((m) => [
        ...m.slice(0, idx).map((x) => (x.id === id ? { ...x, content: editText.trim() } : x)),
        { ...m[idx], content: editText.trim() },
      ]);
      const r = await runStream({ reroll: true }); // 末尾是刚编辑的用户消息，服务端按策略续写
      if (!r.appendedBySpeaker) {
        setMsgs((m) => [
          ...m,
          { id: r.messageId, role: "assistant", content: r.text, characterId: null, emotion: null, starred: false },
        ]);
      }
      if (r.summary) setSummary(r.summary);
    } catch (e) {
      flash(e instanceof Error ? e.message : "编辑失败");
    }
  }

  function removeMsg(id: string) {
    if (!confirm("删除这条消息？（它生成的记忆向量会一并删除）")) return;
    setMsgs((m) => m.filter((x) => x.id !== id));
    startTransition(() => deleteMessage(id));
  }

  /* ------------------------------ 会话级切换 ------------------------------ */
  function patchConv(patch: Partial<Conv>) {
    setConv((c) => ({ ...c, ...patch }));
    startTransition(() => updateConversation(conv.id, patch));
  }

  /* ------------------------------ 群聊成员管理 ------------------------------ */
  function addMember(characterId: string) {
    if (!characterId) return;
    startTransition(async () => {
      await addConversationMember(conv.id, characterId);
      flash("已加入群聊，下一轮开始生效");
    });
  }

  function removeMember(characterId: string) {
    if (members.length <= 1) return;
    startTransition(async () => {
      await removeConversationMember(conv.id, characterId);
      flash("已移出群聊（其历史消息保留）");
    });
  }

  /* ------------------------------ 连载工具 ------------------------------ */
  function genHook() {
    setBusy(true);
    startTransition(async () => {
      try {
        setHook(await generateHook(conv.id));
      } catch (e) {
        flash(e instanceof Error ? e.message : "生成失败");
      } finally {
        setBusy(false);
      }
    });
  }

  function saveHookToWorldbook() {
    startTransition(async () => {
      await saveEntryForCharacter(character.id, {
        category: "事件",
        title: `第${conv.chapter}章钩子`,
        content: hook.slice(0, 200),
        keywords: [],
        weight: 6,
        sort: 0,
        enabled: true,
      });
      flash("钩子已存入世界书（事件条目）");
      setHook("");
    });
  }

  function saveDraft(d: Draft) {
    return saveEntryForCharacter(character.id, {
      category: (["人物", "地点", "事件", "规则"].includes(d.category) ? d.category : "事件") as WbCategory,
      title: d.title,
      content: d.content,
      keywords: d.keywords,
      weight: d.weight,
      sort: 0,
      enabled: true,
    });
  }

  function runDistill() {
    setBusy(true);
    startTransition(async () => {
      try {
        setDrafts(await distillWorldbookDraft(conv.id));
      } catch (e) {
        flash(e instanceof Error ? e.message : "提炼失败");
      } finally {
        setBusy(false);
      }
    });
  }

  /* -------------------------------- 渲染 -------------------------------- */
  const lastAssistant = lastAssistantId(msgs);
  const nameOf = (cid?: string | null) => members.find((x) => x.id === cid) ?? null;

  return (
    <div className="flex min-h-[calc(100vh-7.5rem)] flex-col gap-3 lg:flex-row">
      {/* 主聊天列 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <div className={card + " flex flex-wrap items-center gap-2 px-4 py-2.5"}>
          <Link href="/" className="text-sm text-zinc-400 hover:text-indigo-500">
            ←
          </Link>
          <span className="text-lg">{character.emoji}</span>
          <span className="text-sm font-semibold">{isGroup ? conv.title : character.name}</span>

          <select
            className="ml-2 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs"
            value={conv.mode}
            onChange={(e) => patchConv({ mode: e.target.value as Mode })}
          >
            <option value="daily">{MODE_LABEL.daily}</option>
            <option value="story">{MODE_LABEL.story}</option>
          </select>

          <select
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs"
            value={conv.tier}
            onChange={(e) => patchConv({ tier: e.target.value as Tier })}
            title="开局试错用轻量，定稿连载提质量"
          >
            <option value="light">轻量档</option>
            <option value="quality">高质量档</option>
          </select>

          {isGroup && conv.groupStrategy && (
            <select
              className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs"
              value={conv.groupStrategy}
              onChange={(e) => patchConv({ groupStrategy: e.target.value as GroupStrategy })}
              title="群聊发言策略"
            >
              {(Object.keys(GROUP_STRATEGY_LABEL) as GroupStrategy[]).map((s) => (
                <option key={s} value={s}>
                  {GROUP_STRATEGY_LABEL[s]}
                </option>
              ))}
            </select>
          )}

          {conv.mode === "story" && (
            <span className={badge + " bg-emerald-50 text-emerald-600"}>
              第 {conv.chapter} 章
              <button
                className="ml-1 text-emerald-700 hover:underline"
                disabled={pending}
                onClick={() => patchConv({ chapter: conv.chapter + 1 })}
              >
                开新章
              </button>
            </span>
          )}

          <div className="ml-auto flex gap-2">
            <a className={btnGhost + " text-xs"} href={`/api/export?conversationId=${conv.id}&format=txt`}>
              导出 TXT
            </a>
            <a className={btnGhost + " text-xs"} href={`/api/export?conversationId=${conv.id}&format=json`}>
              JSON
            </a>
          </div>
        </div>

        {/* 消息列表 */}
        <div className={card + " mt-3 flex flex-1 flex-col overflow-y-auto p-4"}>
          <div className="flex flex-col gap-4">
            {msgs.map((m) => {
              const isEditing = editingId === m.id;
              const speaker = m.role === "assistant" ? nameOf(m.characterId) : null;
              return (
                <div key={m.id} className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}>
                  <div className={"max-w-[85%] " + (m.role === "user" ? "text-right" : "")}>
                    {speaker && (
                      <span className="mb-1 block text-xs font-medium" style={{ color: speaker.color }}>
                        {speaker.emoji} {speaker.name}
                      </span>
                    )}
                    {m.emotion && (
                      <span className={badge + " mb-1 bg-pink-50 text-pink-500"}>目标：{m.emotion}</span>
                    )}
                    {isEditing ? (
                      <div className="text-left">
                        <textarea
                          className="w-full rounded-2xl border border-indigo-300 bg-white px-4 py-2.5 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-indigo-100"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={3}
                          autoFocus
                        />
                        <div className="mt-1 flex justify-end gap-2">
                          <button className={btnGhost + " text-xs"} onClick={() => setEditingId(null)}>
                            取消
                          </button>
                          <button className={btnPrimary + " text-xs"} disabled={busy || !editText.trim()} onClick={saveEdit}>
                            保存并重新生成
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={
                          "inline-block whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-left text-sm leading-relaxed " +
                          (m.role === "user"
                            ? "bg-indigo-600 text-white"
                            : speaker
                              ? "bg-white border border-zinc-200 text-zinc-800"
                              : "bg-zinc-100 text-zinc-800")
                        }
                      >
                        {m.content}
                      </div>
                    )}
                    {!isEditing && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                        <button
                          className={m.starred ? "text-amber-500" : "hover:text-amber-500"}
                          title="复盘星标：标出满意的回复"
                          onClick={() => {
                            setMsgs((list) => list.map((x) => (x.id === m.id ? { ...x, starred: !x.starred } : x)));
                            startTransition(() => toggleStar(m.id));
                          }}
                        >
                          ★ {m.starred ? "已标" : "星标"}
                        </button>
                        <button className="hover:text-zinc-700" onClick={() => navigator.clipboard.writeText(m.content)}>
                          复制
                        </button>
                        <button
                          className="hover:text-indigo-500"
                          onClick={async () => {
                            stopSpeak();
                            try {
                              await speak(m.content, {
                                rate: Number(localStorage.getItem("himuro-tts-rate")) || 1,
                                pitch: Number(localStorage.getItem("himuro-tts-pitch")) || 1,
                                voiceURI: localStorage.getItem("himuro-tts-voice") || undefined,
                              });
                            } catch (e) {
                              flash(e instanceof Error ? e.message : "TTS 失败");
                            }
                          }}
                        >
                          ▶ 试听
                        </button>
                        {m.role === "user" && (
                          <button className="hover:text-indigo-500" onClick={() => startEdit(m)}>
                            ✎ 编辑
                          </button>
                        )}
                        {m.role === "assistant" && m.id === lastAssistant && (
                          <button className="hover:text-indigo-500" disabled={busy} onClick={() => reroll(m.id)}>
                            ↻ 重Roll
                          </button>
                        )}
                        {m.role === "assistant" && (
                          <button
                            className="hover:text-emerald-600"
                            title="把这条回复连同你的上一句话存进角色卡示例对话（复盘回写）"
                            onClick={() =>
                              startTransition(async () => {
                                await writeBackExample(m.id);
                                flash("已回写进角色卡示例对话");
                              })
                            }
                          >
                            ↩ 存为示例
                          </button>
                        )}
                        <button className="hover:text-red-500" onClick={() => removeMsg(m.id)}>
                          🗑
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {streaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%]">
                  {currentSpeaker && (
                    <span className="mb-1 block text-xs font-medium" style={{ color: nameOf(currentSpeaker.characterId)?.color ?? "#6366f1" }}>
                      {currentSpeaker.emoji} {currentSpeaker.name} 正在说…
                    </span>
                  )}
                  <div className="himuro-caret inline-block max-w-full whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-2.5 text-left text-sm leading-relaxed text-zinc-800">
                    {streaming}
                  </div>
                </div>
              </div>
            )}
          </div>
          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div className={card + " mt-3 p-3"}>
          {conv.mode === "daily" && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-zinc-400">情绪目标：</span>
              {EMOTION_PRESETS.map((e) => (
                <button
                  key={e}
                  className={
                    "rounded-full px-2.5 py-1 text-xs transition " +
                    (emotion === e
                      ? "bg-pink-500 text-white"
                      : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200")
                  }
                  onClick={() => setEmotion(emotion === e ? null : e)}
                >
                  {e}
                </button>
              ))}
              <input
                className={input + " ml-1 h-7 w-28 rounded-full px-3 py-0 text-xs"}
                placeholder="自定义…"
                value={emotion && !EMOTION_PRESETS.includes(emotion as (typeof EMOTION_PRESETS)[number]) ? emotion : ""}
                onChange={(e) => setEmotion(e.target.value || null)}
              />
              {isGroup && conv.groupStrategy === "mention" && (
                <span className="ml-2 text-[11px] text-zinc-400">
                  提示：在消息里写成员名字（如「{members[1]?.name ?? character.name}」）即可点名
                </span>
              )}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              className="max-h-40 min-h-11 flex-1 resize-y rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              placeholder={conv.mode === "daily" ? "短提示直给，选个情绪基调更好…" : "描述你的行动或对话，推进剧情…（Ctrl+Enter 发送）"}
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
              }}
              disabled={busy}
            />
            <button className={btnPrimary + " h-11"} disabled={busy || !inputVal.trim()} onClick={send}>
              {busy ? "…" : "发送"}
            </button>
          </div>
        </div>
      </div>

      {/* 右侧栏：群聊成员 + 记忆透明化 + 连载工具 */}
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
        {notice && (
          <div className="rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-600">{notice}</div>
        )}

        {isGroup && (
          <section className={card + " p-4"}>
            <h3 className="mb-2 text-sm font-semibold">群聊成员（{members.length}）</h3>
            <ul className="flex flex-col gap-1.5">
              {members.map((mb) => (
                <li key={mb.id} className="flex items-center gap-2 text-sm">
                  <span className="text-base">{mb.emoji}</span>
                  <span className="min-w-0 flex-1 truncate">{mb.name}</span>
                  {mb.id === character.id ? (
                    <span className={badge + " bg-indigo-50 text-indigo-500"}>主角色</span>
                  ) : (
                    <button
                      className="text-xs text-zinc-400 hover:text-red-500"
                      disabled={pending}
                      onClick={() => removeMember(mb.id)}
                    >
                      移出
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <select
              className={input + " mt-2 text-xs"}
              value=""
              disabled={pending}
              onChange={(e) => addMember(e.target.value)}
            >
              <option value="">＋ 添加成员…</option>
              {allCharacters
                .filter((c) => !members.some((m) => m.id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji} {c.name}
                  </option>
                ))}
            </select>
            <p className="mt-1.5 text-[11px] text-zinc-400">
              策略：{conv.groupStrategy ? GROUP_STRATEGY_LABEL[conv.groupStrategy] : "—"}（顶栏可切换）
            </p>
          </section>
        )}

        {conv.mode === "story" && (
          <section className={card + " p-4"}>
            <h3 className="mb-2 text-sm font-semibold">连载工具</h3>
            <div className="flex gap-2">
              <button className={btnGhost + " flex-1 text-xs"} disabled={busy || pending} onClick={genHook}>
                生成下一章钩子
              </button>
              <button className={btnGhost + " flex-1 text-xs"} disabled={busy || pending} onClick={runDistill}>
                提炼状态→世界书
              </button>
            </div>
            {hook && (
              <div className="mt-2 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-700">
                {hook}
                <div className="mt-2 flex gap-2">
                  <button className={btnGhost + " text-xs"} onClick={() => navigator.clipboard.writeText(hook)}>
                    复制
                  </button>
                  <button className={btnGhost + " text-xs"} disabled={pending} onClick={saveHookToWorldbook}>
                    存入世界书
                  </button>
                  <button className={btnGhost + " text-xs"} onClick={() => setHook("")}>
                    关闭
                  </button>
                </div>
              </div>
            )}
            {drafts && (
              <div className="mt-2 rounded-xl bg-violet-50 p-3 text-xs text-violet-700">
                <div className="mb-1.5 font-medium">提炼草稿（勾选后保存）</div>
                {drafts.length === 0 && <div>最近对话里没有值得记录的新信息。</div>}
                {drafts.map((d, i) => (
                  <label key={i} className="mb-1.5 flex items-start gap-1.5">
                    <input
                      type="checkbox"
                      defaultChecked
                      className="mt-0.5 accent-violet-600"
                      onChange={(e) => setDrafts((ds) => ds!.map((x, xi) => (xi === i ? { ...x, __keep: e.target.checked } as Draft : x)))}
                    />
                    <span>
                      <b>{d.title}</b>（{d.category}·权重{d.weight}）：{d.content}
                    </span>
                  </label>
                ))}
                {drafts.length > 0 && (
                  <button
                    className={btnPrimary + " mt-1 w-full text-xs"}
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        for (const d of drafts) {
                          if ((d as Draft & { __keep?: boolean }).__keep === false) continue;
                          await saveDraft(d);
                        }
                        setDrafts(null);
                        flash("已保存进世界书，可回角色页查看");
                      })
                    }
                  >
                    保存所选条目
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        <section className={card + " p-4"}>
          <h3 className="mb-2 text-sm font-semibold">
            本轮世界书命中{hits.speaker ? `（${hits.speaker}）` : ""}
          </h3>
          {hits.hits.length === 0 ? (
            <p className="text-xs text-zinc-400">暂无命中。聊天内容里出现条目关键词时，对应设定会自动注入。</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {hits.hits.map((h, i) => (
                <span key={i} className={badge + " bg-emerald-50 text-emerald-600"}>
                  {h.category}·{h.title}（{h.weight}）
                </span>
              ))}
            </div>
          )}
          <Link href={`/worldbooks/${character.id}`} className="mt-2 inline-block text-[11px] text-indigo-500 hover:underline">
            管理世界书 →
          </Link>
        </section>

        <section className={card + " p-4"}>
          <h3 className="mb-2 text-sm font-semibold">长会话记忆（摘要）</h3>
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-zinc-500">
            {summary || "对话变长后会自动生成滚动摘要，这里可以随时查看。"}
          </p>
        </section>

        <section className={card + " p-4 text-xs text-zinc-400"}>
          <div className="mb-1 font-medium text-zinc-500">当前档位</div>
          {conv.tier === "quality" ? TIER_LABEL.quality : TIER_LABEL.light}
          （在设置页配置对应 API；默认内置演示模型，无需联网）
        </section>
      </aside>
    </div>
  );
}
