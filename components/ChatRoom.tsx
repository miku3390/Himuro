"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  addConversationMember,
  deleteMessageTree,
  editUserMessageBranch,
  removeConversationMember,
  saveEntryForCharacter,
  switchAlternative,
  toggleStar,
  updateConversation,
  writeBackExample,
} from "@/lib/actions";
import { generateHook, distillWorldbookDraft } from "@/lib/story";
import {
  currentProvider,
  downloadTts,
  fetchSpeech,
  speak,
  speakSegment,
  stopSpeak,
} from "@/lib/tts";
import { splitSentences } from "@/lib/ttsText";
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
import type { TtsProvider } from "@/lib/settings";
import { badge, btnGhost, btnPrimary, card, input } from "@/lib/ui";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  characterId?: string | null;
  emotion: string | null;
  starred: boolean;
  /** 分支树：兄弟备选组内的位置与总数（服务端算好下发；本地乐观追加时填 1/1） */
  altIndex?: number;
  altCount?: number;
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

/** 分支树面板：活跃路径上某个消息的兄弟备选组（服务端算好下发） */
export type ForkOption = { id: string; index: number; excerpt: string; active: boolean };
export type Fork = {
  id: string;
  isUser: boolean;
  altIndex: number;
  altCount: number;
  options: ForkOption[];
};

function lastAssistantId(list: Msg[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === "assistant") return list[i].id;
  return null;
}

/** 触发一次文件下载。必须先挂进文档再点，Firefox/Safari 对游离的 <a> 不买账 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器拿不到内容，留十秒
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 文件名里不能出现的字符换成下划线 */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
}

export default function ChatRoom({
  conversation,
  character,
  members,
  isGroup,
  allCharacters,
  initialMessages,
  forks,
  totalMessages,
}: {
  conversation: Conv;
  character: CharacterCard;
  members: Member[];
  isGroup: boolean;
  allCharacters: Member[];
  initialMessages: Msg[];
  /** 分叉点列表（活跃路径上有兄弟备选的消息），服务端算好下发 */
  forks: Fork[];
  totalMessages: number;
}) {
  const [conv, setConv] = useState(conversation);
  const [msgs, setMsgs] = useState<Msg[]>(initialMessages);
  const [inputVal, setInputVal] = useState("");
  const [emotion, setEmotion] = useState<string | null>(null);
  const [streaming, setStreaming] = useState("");
  const [currentSpeaker, setCurrentSpeaker] = useState<Speaker | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在重Roll的那条消息（旧回复留着并压暗，成功后才被新回复替换） */
  const [rerollingId, setRerollingId] = useState<string | null>(null);
  /** 导出配音面板：范围 + 进度 */
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"all" | "starred">("all");
  const [exporting, setExporting] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [hits, setHits] = useState<{ speaker?: string; hits: Hit[] }>({ hits: [] });
  const [summary, setSummary] = useState(conversation.summary);
  const [hook, setHook] = useState("");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement>(null);
  // busy 是 state，同一帧内连点两次时第二次读到的还是 false；真正的互斥靠这个 ref
  const busyRef = useRef(false);
  /** 导出配音的在途请求（中断按钮用） */
  const exportAbortRef = useRef<AbortController | null>(null);

  /* TTS 分段面板状态：长文本逐段试听/下载 */
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("browser");
  const [ttsPanelFor, setTtsPanelFor] = useState<string | null>(null);
  const [ttsSegments, setTtsSegments] = useState<string[]>([]);
  const [ttsProgress, setTtsProgress] = useState<string | null>(null);

  useEffect(() => {
    setTtsProvider(currentProvider());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, streaming]);

  // router.refresh() 后服务端会下发新的活跃路径，同步进本地状态
  useEffect(() => {
    setMsgs(initialMessages);
  }, [initialMessages]);

  function flash(text: string) {
    setNotice(text);
    setTimeout(() => setNotice(""), 2500);
  }

  /* ---------------------------- SSE 流式公共流程 ---------------------------- */
  // 群聊一轮会有多个发言者：每个 speaker 的文本通过 speaker_done 先行落库/上屏，
  // done 事件只负责收尾（摘要）。单聊则由 done 追加唯一的回复。
  // 用户消息的真 id 由流开头的 user_msg 事件给出：流中断时 done 不会来，但那条消息
  // 早已落库，客户端必须拿真 id 才能继续编辑/删除/星标（这些操作都按 id 找服务端行）。
  // 流中途出错不抛异常，改为在返回值里带 error，调用方好判断手里的消息该留还是该撤。
  type StreamResult = {
    messageId: string;
    userMessageId?: string;
    text: string;
    summary?: string;
    appendedBySpeaker: boolean;
    error?: string;
  };

  async function runStream(
    payload: { content?: string; emotion?: string | null; reroll?: boolean; rerollMessageId?: string },
  ): Promise<StreamResult> {
    setBusy(true);
    busyRef.current = true;
    let appendedBySpeaker = false;
    let acc = "";
    let speakerAcc = "";
    let userMessageId: string | undefined;
    let streamError: string | undefined;
    let done: { messageId: string; userMessageId?: string; summary?: string } | null = null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id, ...payload }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "请求失败" }));
        // HTTP 层就失败了：服务端是先判定发言者再落库，这里确定什么都没写
        return {
          messageId: "",
          text: "",
          appendedBySpeaker: false,
          error: err.error ?? `HTTP ${res.status}`,
        };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
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
          if (evt.t === "user_msg") {
            userMessageId = evt.id;
          } else if (evt.t === "hits") {
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
            streamError = evt.message;
          }
        }
        if (streamError) break;
      }
      if (!done && !streamError) streamError = "回复流中断";
      return {
        messageId: done?.messageId ?? "",
        userMessageId: userMessageId ?? done?.userMessageId,
        text: acc,
        summary: done?.summary,
        appendedBySpeaker,
        error: streamError,
      };
    } catch (e) {
      // 网络中断等：用户消息可能已经落库，带上已知的真 id 交给调用方判断
      return {
        messageId: "",
        userMessageId,
        text: acc,
        appendedBySpeaker,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      setStreaming("");
      setCurrentSpeaker(null);
      setBusy(false);
      busyRef.current = false;
    }
  }

  /* ------------------------------- 发送消息 ------------------------------- */
  async function send() {
    const content = inputVal.trim();
    if (!content || busyRef.current) return;
    setInputVal("");
    const tmpId = `tmp-user-${Date.now()}`;
    setMsgs((m) => [...m, { id: tmpId, role: "user", content, emotion, starred: false }]);
    const r = await runStream({ content, emotion });
    // 真 id 已由 user_msg 事件拿到；一条都没拿到说明服务端根本没落库，撤掉乐观气泡
    const realId = r.userMessageId;
    setMsgs((m) => {
      const settled = realId
        ? m.map((x) => (x.id === tmpId ? { ...x, id: realId } : x))
        : m.filter((x) => x.id !== tmpId);
      if (r.error || r.appendedBySpeaker) return settled;
      return [
        ...settled,
        {
          id: r.messageId,
          role: "assistant" as const,
          content: r.text,
          characterId: null,
          emotion: null,
          starred: false,
        },
      ];
    });
    if (r.error) flash(r.error);
    if (r.summary) setSummary(r.summary);
    setEmotion(null);
  }

  /* -------------------- 重Roll：生成新的兄弟分支（旧回复保留） -------------------- */
  async function reroll(messageId?: string) {
    if (busyRef.current) return;
    const target = messageId ?? lastAssistantId(msgs);
    if (!target) return;
    // 分支树：不乐观删除。旧回复标成「重Roll中」留在原位，新回复生成成功后
    // 成为它的兄弟分支（父节点活跃指针指向新回复），旧分支随时可切回
    setRerollingId(target);
    try {
      const r = await runStream({ reroll: true, rerollMessageId: target });
      if (r.error) {
        flash(r.error);
        return;
      }
      setMsgs((m) => [
        ...m.map((x) =>
          // 原地把旧回复换成新回复（视觉位置不变），旧的靠 router.refresh 后的 ‹ i/n › 切回
          x.id === target
            ? {
                ...x,
                id: r.messageId,
                content: r.text,
                altIndex: 1,
                altCount: 1,
              }
            : x,
        ),
        ...(r.appendedBySpeaker
          ? []
          : m.some((x) => x.id === r.messageId)
            ? []
            : [
                {
                  id: r.messageId,
                  role: "assistant" as const,
                  content: r.text,
                  characterId: null,
                  emotion: null,
                  starred: false,
                  altIndex: 1,
                  altCount: 1,
                } as Msg,
              ]),
      ]);
      if (r.summary) setSummary(r.summary);
      router.refresh(); // 同步规范的分支序号（旧回复变成 ‹ 1/2 › 可切回）
    } finally {
      setRerollingId(null);
    }
  }

  /* ------------------- 编辑用户消息 → 新建兄弟分支 → 续写回复 ------------------- */
  function startEdit(m: Msg) {
    setEditingId(m.id);
    setEditText(m.content);
  }

  async function saveEdit() {
    if (!editingId || busyRef.current) return;
    const id = editingId;
    setEditingId(null);
    try {
      const r = await editUserMessageBranch(id, editText);
      // 本地先行切到新分支：编辑点之后的消息随旧分支离开视野
      setMsgs((m) => {
        const idx = m.findIndex((x) => x.id === id);
        if (idx < 0) return m;
        return [...m.slice(0, idx), { ...m[idx], id: r.newUserMessageId, content: editText.trim() }];
      });
      const s = await runStream({ reroll: true }); // 活跃路径末尾是刚建的用户消息 → 服务端续写
      if (s.error) {
        flash(s.error);
        return;
      }
      if (!s.appendedBySpeaker) {
        setMsgs((m) => [
          ...m,
          {
            id: s.messageId,
            role: "assistant",
            content: s.text,
            characterId: null,
            emotion: null,
            starred: false,
            altIndex: 1,
            altCount: 1,
          },
        ]);
      }
      if (s.summary) setSummary(s.summary);
      router.refresh(); // 拿到规范的分支序号
    } catch (e) {
      flash(e instanceof Error ? e.message : "编辑失败");
      router.refresh();
    }
  }

  function removeMsg(id: string) {
    if (!confirm("删除这条消息及其所有分支后续？（记忆向量会一并删除）")) return;
    setMsgs((m) => {
      const idx = m.findIndex((x) => x.id === id);
      return idx < 0 ? m : m.slice(0, idx);
    });
    startTransition(async () => {
      await deleteMessageTree(id);
      router.refresh();
    });
  }

  /* ------------------------------ 分支切换 ------------------------------ */
  function switchBranch(id: string, delta: number) {
    startTransition(async () => {
      await switchAlternative(id, delta);
      router.refresh();
    });
  }

  /** 分支树面板：直接跳到某个兄弟备选（delta = 目标序号 − 当前序号） */
  function jumpToForkOption(fork: Fork, opt: ForkOption) {
    if (opt.active) return;
    switchBranch(fork.id, opt.index - fork.altIndex);
  }

  /* ---------------------------- TTS 逐段试听/下载 ---------------------------- */
  function ttsOpts(m: Msg) {
    return {
      rate: Number(localStorage.getItem("himuro-tts-rate")) || 1,
      pitch: Number(localStorage.getItem("himuro-tts-pitch")) || 1,
      voiceURI: localStorage.getItem("himuro-tts-voice") || undefined,
      characterId: m.characterId ?? character.id,
      onProgress: (i: number, n: number) => setTtsProgress(`${i}/${n}`),
    };
  }

  /** 短文本直接播；长文本展开逐段面板（GPT-SoVITS 长句合成又慢又差） */
  async function handleListen(m: Msg) {
    stopSpeak();
    setTtsProgress(null);
    const segs = splitSentences(m.content);
    if (ttsProvider !== "browser" && segs.length > 2) {
      setTtsSegments(segs);
      setTtsPanelFor(m.id);
      return;
    }
    try {
      await speak(m.content, ttsOpts(m));
    } catch (e) {
      flash(e instanceof Error ? e.message : "TTS 失败");
    } finally {
      setTtsProgress(null);
    }
  }

  async function playSegment(m: Msg, seg: string) {
    try {
      await speakSegment(seg, ttsOpts(m));
    } catch (e) {
      flash(e instanceof Error ? e.message : "TTS 失败");
    }
  }

  async function downloadSegment(m: Msg, seg: string) {
    try {
      await downloadTts(seg, m.characterId ?? character.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : "下载失败");
    }
  }

  async function handleDownloadVoice(m: Msg) {
    const segs = splitSentences(m.content);
    if (segs.length > 2) {
      setTtsSegments(segs);
      setTtsPanelFor(ttsPanelFor === m.id ? null : m.id);
      return;
    }
    try {
      await downloadTts(m.content, m.characterId ?? character.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : "下载失败");
    }
  }

  /* --------------------------- 导出配音（逐句合成） --------------------------- */
  // 风月口径：语音只增强关键情绪节点，不替代全文。所以给两种范围——
  // 全部角色回复（整篇试听/归档），或只导出星标句（那些被打上「高潮句」标记的）。
  const exportTargets = msgs.filter(
    (m) => m.role === "assistant" && m.content.trim() && (exportScope === "all" || m.starred),
  );

  async function exportSpeech() {
    if (exportAbortRef.current) return;
    const targets = exportTargets;
    if (targets.length === 0) {
      flash(exportScope === "starred" ? "这个会话里还没有星标句" : "这个会话里没有角色回复");
      return;
    }
    stopSpeak(); // 先停掉试听，别让正在合成/播放的音频掺进来
    const abort = new AbortController();
    exportAbortRef.current = abort;
    setExporting({ done: 0, total: targets.length, failed: 0 });
    const rate = Number(localStorage.getItem("himuro-tts-rate")) || 1;
    let failed = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        if (abort.signal.aborted) break;
        const m = targets[i];
        try {
          // 逐条串行：GPT-SoVITS 单卡，并发只会互相排队，还容易把显存打满
          const { blob, ext } = await fetchSpeech(m.content, {
            characterId: m.characterId ?? character.id,
            rate,
            signal: abort.signal,
          });
          const seq = String(i + 1).padStart(2, "0");
          const who = safeName(nameOf(m.characterId)?.name ?? character.name);
          saveBlob(blob, `${seq}-${who}.${ext}`);
        } catch (e) {
          if (abort.signal.aborted) break;
          failed++;
          flash(e instanceof Error ? e.message : "合成失败");
        }
        setExporting({ done: i + 1, total: targets.length, failed });
        // 给浏览器一点空档，连续下载太快会被当成弹窗滥用拦掉
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      const stopped = abort.signal.aborted;
      exportAbortRef.current = null;
      setExporting(null);
      if (stopped) flash("已中断，已经下载的文件保留");
      else if (failed) flash(`导出结束：成功 ${targets.length - failed} 条，失败 ${failed} 条`);
      else flash(`导出完成：${targets.length} 条音频`);
    }
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
    if (busyRef.current) return;
    setBusy(true);
    busyRef.current = true;
    startTransition(async () => {
      try {
        setHook(await generateHook(conv.id));
      } catch (e) {
        flash(e instanceof Error ? e.message : "生成失败");
      } finally {
        setBusy(false);
        busyRef.current = false;
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
    if (busyRef.current) return;
    setBusy(true);
    busyRef.current = true;
    startTransition(async () => {
      try {
        setDrafts(await distillWorldbookDraft(conv.id));
      } catch (e) {
        flash(e instanceof Error ? e.message : "提炼失败");
      } finally {
        setBusy(false);
        busyRef.current = false;
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

          <div className="ml-auto flex items-center gap-2">
            <button
              className={btnGhost + " text-xs"}
              onClick={() => setExportOpen((v) => !v)}
              title="逐句合成音频并逐条下载"
            >
              导出配音
            </button>
            <a className={btnGhost + " text-xs"} href={`/api/export?conversationId=${conv.id}&format=txt`}>
              导出 TXT
            </a>
            <a className={btnGhost + " text-xs"} href={`/api/export?conversationId=${conv.id}&format=json`}>
              JSON
            </a>
          </div>
        </div>

        {exportOpen && (
          <div className={card + " mt-3 flex flex-wrap items-center gap-3 px-4 py-3 text-xs"}>
            <span className="font-medium">导出配音</span>
            <select
              className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs"
              value={exportScope}
              disabled={!!exporting}
              onChange={(e) => setExportScope(e.target.value as "all" | "starred")}
            >
              <option value="all">全部角色回复</option>
              <option value="starred">仅星标句（关键情绪节点）</option>
            </select>
            <span className="text-zinc-500">
              共 {exportTargets.length} 条，逐条合成后按「序号-角色名」下载；浏览器首次会问是否允许下载多个文件
            </span>
            {exporting ? (
              <>
                <span className="text-indigo-600">
                  合成中 {exporting.done}/{exporting.total}
                  {exporting.failed ? `（失败 ${exporting.failed}）` : ""}
                </span>
                <button className={btnGhost + " text-xs"} onClick={() => exportAbortRef.current?.abort()}>
                  中断
                </button>
              </>
            ) : (
              <button className={btnPrimary + " text-xs"} disabled={exportTargets.length === 0} onClick={exportSpeech}>
                开始导出
              </button>
            )}
          </div>
        )}

        {/* 消息列表 */}
        <div className={card + " mt-3 flex flex-1 flex-col overflow-y-auto p-4"}>
          <div className="flex flex-col gap-4">
            {msgs.map((m) => {
              const isEditing = editingId === m.id;
              const speaker = m.role === "assistant" ? nameOf(m.characterId) : null;
              return (
                <div
                  key={m.id}
                  className={
                    "flex " +
                    (m.role === "user" ? "justify-end" : "justify-start") +
                    (rerollingId === m.id ? " opacity-40" : "")
                  }
                >
                  <div className={"max-w-[85%] " + (m.role === "user" ? "text-right" : "")}>
                    {rerollingId === m.id && (
                      <span className={badge + " mb-1 bg-amber-50 text-amber-600"}>重Roll中…</span>
                    )}
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
                    {ttsPanelFor === m.id && (
                      <div className="mt-1 rounded-xl border border-zinc-200 bg-zinc-50 p-2.5 text-left text-xs">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <span className="font-medium text-zinc-600">
                            逐段朗读{ttsProgress ? `（${ttsProgress}）` : ""}
                          </span>
                          <button className="text-indigo-500 hover:underline" onClick={() => handleListen(m)}>
                            ▶ 全部播放
                          </button>
                          <button className="text-zinc-500 hover:underline" onClick={stopSpeak}>
                            ⏹ 停止
                          </button>
                          <button
                            className="ml-auto text-zinc-400 hover:text-zinc-600"
                            onClick={() => {
                              stopSpeak();
                              setTtsPanelFor(null);
                            }}
                          >
                            收起
                          </button>
                        </div>
                        <div className="flex flex-col gap-1">
                          {ttsSegments.map((seg, i) => (
                            <div key={i} className="flex items-start gap-1.5">
                              <span className="mt-0.5 shrink-0 text-zinc-400">{i + 1}.</span>
                              <span className="min-w-0 flex-1 leading-relaxed text-zinc-600">{seg}</span>
                              <button className="shrink-0 text-indigo-500" title="播放本段" onClick={() => playSegment(m, seg)}>
                                ▶
                              </button>
                              <button className="shrink-0 text-zinc-400 hover:text-indigo-500" title="下载本段" onClick={() => downloadSegment(m, seg)}>
                                ⬇
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {!isEditing && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                        {(m.altCount ?? 1) > 1 && (
                          <span className="flex items-center gap-1">
                            <button
                              className="hover:text-indigo-500 disabled:opacity-40"
                              disabled={busy || pending}
                              title="上一个分支"
                              onClick={() => switchBranch(m.id, -1)}
                            >
                              ‹
                            </button>
                            <span title="分支备选：重Roll/编辑留下的历史版本，可随时切回">
                              {m.altIndex ?? 1}/{m.altCount ?? 1}
                            </span>
                            <button
                              className="hover:text-indigo-500 disabled:opacity-40"
                              disabled={busy || pending}
                              title="下一个分支"
                              onClick={() => switchBranch(m.id, 1)}
                            >
                              ›
                            </button>
                          </span>
                        )}
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
                          onClick={() => handleListen(m)}
                          title={m.characterId ? "用该角色自己的音色朗读" : undefined}
                        >
                          ▶ 试听
                        </button>
                        {ttsProvider !== "browser" && (
                          <button className="hover:text-indigo-500" title="下载语音文件" onClick={() => handleDownloadVoice(m)}>
                            ⬇ 语音
                          </button>
                        )}
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

      {/* 右侧栏：分支树 + 群聊成员 + 记忆透明化 + 连载工具 */}
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
        {notice && (
          <div className="rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-600">{notice}</div>
        )}

        {forks.length > 0 && (
          <section className={card + " p-4"}>
            <h3 className="mb-2 text-sm font-semibold">分支树（{forks.length} 个分叉点）</h3>
            <div className="flex flex-col gap-2.5">
              {forks.map((fork) => (
                <div key={fork.id} className="rounded-xl bg-zinc-50 p-2 text-xs">
                  <div className="mb-1 flex items-center gap-1.5 text-zinc-500">
                    <span>{fork.isUser ? "👤 你的话" : `💬 ${character.name}的回复`}</span>
                    <span className="ml-auto text-zinc-400">
                      {fork.altIndex}/{fork.altCount}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {fork.options.map((opt) => (
                      <button
                        key={opt.id}
                        className={
                          "flex items-center gap-1.5 rounded-lg px-2 py-1 text-left transition " +
                          (opt.active
                            ? "bg-indigo-100 text-indigo-700"
                            : "text-zinc-500 hover:bg-zinc-200/70")
                        }
                        disabled={pending || busy}
                        title={opt.active ? "当前分支" : "切换到这个分支"}
                        onClick={() => jumpToForkOption(fork, opt)}
                      >
                        <span className={opt.active ? "text-indigo-500" : "text-zinc-400"}>
                          {opt.active ? "●" : "○"}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {opt.index}. {opt.excerpt}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-zinc-400">
              活跃路径 {msgs.length} 条 · 库里共 {totalMessages} 条（其余在死分支里，随时可切回）
            </p>
          </section>
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
