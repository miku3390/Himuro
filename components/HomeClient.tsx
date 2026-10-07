"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createConversation, createGroupConversation, deleteConversation, duplicateCharacter } from "@/lib/actions";
import { GROUP_STRATEGY_LABEL, MODE_LABEL, TIER_LABEL, type CharacterCard, type GroupStrategy, type Mode } from "@/lib/types";
import { badge, btnGhost, btnPrimary, card } from "@/lib/ui";

type ConvRow = {
  id: string;
  title: string;
  mode: string;
  tier: string;
  chapter: number;
  groupStrategy: string | null;
  updatedAt: number;
  characterName: string;
  characterEmoji: string;
  characterColor: string;
};

export default function HomeClient({
  conversations,
  myCharacters,
  templates,
}: {
  conversations: ConvRow[];
  myCharacters: CharacterCard[];
  templates: CharacterCard[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [charId, setCharId] = useState(myCharacters[0]?.id ?? "");
  const [mode, setMode] = useState<Mode>("daily");
  const [groupMode, setGroupMode] = useState(false);
  const [groupPicks, setGroupPicks] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<GroupStrategy>("mention");
  const [error, setError] = useState("");

  function start(withCharId: string, withMode: Mode) {
    setError("");
    startTransition(async () => {
      try {
        const { id } = await createConversation(withCharId, withMode);
        router.push(`/chat/${id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function startGroup() {
    setError("");
    startTransition(async () => {
      try {
        const { id } = await createGroupConversation(groupPicks, strategy);
        router.push(`/chat/${id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function importConversation(file: File) {
    setError("");
    startTransition(async () => {
      try {
        const json = JSON.parse(await file.text());
        const res = await fetch("/api/import/conversation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(json),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        router.push(`/chat/${data.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "导入失败");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 新建会话 */}
      <section className={card + " p-5"}>
        <div className="mb-4 flex items-center">
          <h2 className="text-base font-semibold">开一场新对话</h2>
          <div className="ml-auto flex items-center gap-1 text-xs">
            <label className={btnGhost + " cursor-pointer text-xs"} title="导入 Himuro 会话导出的 JSON 文件">
              导入会话
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importConversation(f);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              className={
                "rounded-lg px-3 py-1.5 transition " +
                (!groupMode ? "bg-indigo-600 text-white" : "text-zinc-500 hover:bg-zinc-100")
              }
              onClick={() => setGroupMode(false)}
            >
              单聊
            </button>
            <button
              className={
                "rounded-lg px-3 py-1.5 transition " +
                (groupMode ? "bg-indigo-600 text-white" : "text-zinc-500 hover:bg-zinc-100")
              }
              onClick={() => setGroupMode(true)}
              disabled={myCharacters.length < 2}
              title={myCharacters.length < 2 ? "群聊至少需要 2 个角色" : undefined}
            >
              群聊
            </button>
          </div>
        </div>
        {myCharacters.length === 0 ? (
          <p className="text-sm text-zinc-500">
            还没有自己的角色。可以先在下方「模板角色中心」试聊或复制一张卡，
            或到 <Link href="/characters" className="text-indigo-600 hover:underline">角色页</Link> 新建。
          </p>
        ) : groupMode ? (
          <div className="flex flex-col gap-4">
            <div>
              <label className="mb-2 block text-xs font-medium text-zinc-500">
                选择成员（至少 2 个，已选 {groupPicks.length}）
              </label>
              <div className="flex flex-wrap gap-2">
                {myCharacters.map((c) => {
                  const picked = groupPicks.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      className={
                        "rounded-full px-3 py-1.5 text-sm transition " +
                        (picked ? "bg-indigo-600 text-white" : "border border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300")
                      }
                      onClick={() =>
                        setGroupPicks((p) => (picked ? p.filter((x) => x !== c.id) : [...p, c.id]))
                      }
                    >
                      {c.emoji} {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500">发言策略</label>
                <select
                  className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as GroupStrategy)}
                >
                  {(Object.keys(GROUP_STRATEGY_LABEL) as GroupStrategy[]).map((s) => (
                    <option key={s} value={s}>
                      {GROUP_STRATEGY_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
              <button className={btnPrimary} disabled={pending || groupPicks.length < 2} onClick={startGroup}>
                开始群聊 →
              </button>
            </div>
            <p className="text-xs text-zinc-400">
              {strategy === "mention" && "谁被@谁答：消息里写到谁的名字，谁就回应；没人被点名则轮换下一位。"}
              {strategy === "rotate" && "依次发言：每轮只有一位成员回应，按成员顺序循环。"}
              {strategy === "all" && "全员发言：每位成员都会依次回应同一条消息（角色多时消耗更大）。"}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 md:flex-row md:items-end">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-zinc-500">选择角色</label>
              <select
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                value={charId}
                onChange={(e) => setCharId(e.target.value)}
              >
                {myCharacters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji} {c.name} —— {c.identity.slice(0, 30) || "（未写身份）"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">模式</label>
              <div className="flex gap-2">
                {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={
                      "rounded-xl px-4 py-2 text-sm transition " +
                      (mode === m
                        ? "bg-indigo-600 text-white"
                        : "border border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300")
                    }
                  >
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </div>
            <button
              className={btnPrimary}
              disabled={pending || !charId}
              onClick={() => start(charId, mode)}
            >
              {pending ? "创建中…" : "开始对话 →"}
            </button>
          </div>
        )}
        {!groupMode && myCharacters.length > 0 && (
          <p className="mt-3 text-xs text-zinc-400">
            {mode === "daily"
              ? "日常聊天：短提示 + 情绪目标（安慰 / 斗嘴 / 并肩作战…），每轮都可换基调。"
              : "连载剧情：状态可追踪，章末自动写「下一章钩子」，关键事件可一键回写世界书。"}
          </p>
        )}
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      </section>

      {/* 会话列表 */}
      <section>
        <h2 className="mb-3 text-base font-semibold">进行中的会话</h2>
        {conversations.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center text-sm text-zinc-400">
            还没有会话，从上面开一场吧。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {conversations.map((c) => (
              <li
                key={c.id}
                className={card + " flex items-center gap-3 px-4 py-3 transition hover:border-indigo-200"}
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg"
                  style={{ backgroundColor: c.characterColor + "22" }}
                >
                  {c.characterEmoji}
                </span>
                <Link href={`/chat/${c.id}`} className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
                    {c.groupStrategy && (
                      <span className={badge + " bg-violet-50 text-violet-600"}>
                        群聊·{GROUP_STRATEGY_LABEL[c.groupStrategy as GroupStrategy]}
                      </span>
                    )}
                    <span className={badge + " bg-indigo-50 text-indigo-600"}>
                      {c.mode === "story" ? MODE_LABEL.story : MODE_LABEL.daily}
                    </span>
                    <span className={badge + " bg-zinc-100 text-zinc-500"}>
                      {c.tier === "quality" ? TIER_LABEL.quality : TIER_LABEL.light}
                    </span>
                    {c.mode === "story" && (
                      <span className={badge + " bg-emerald-50 text-emerald-600"}>第 {c.chapter} 章</span>
                    )}
                    <span>{new Date(c.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span>
                  </div>
                </Link>
                <Link href={`/chat/${c.id}`} className={btnGhost + " shrink-0"}>
                  继续
                </Link>
                <button
                  className={btnGhost + " shrink-0"}
                  onClick={() => {
                    if (confirm(`删除会话「${c.title}」？该操作不可恢复。`)) {
                      startTransition(() => deleteConversation(c.id));
                    }
                  }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 模板角色中心 */}
      <section>
        <h2 className="mb-1 text-base font-semibold">模板角色中心</h2>
        <p className="mb-3 text-xs text-zinc-400">
          官方建议：先用模板聊满 10 轮找节奏，再复制成自己的卡去改 —— 每轮只改一个变量。
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {templates.map((t) => (
            <div key={t.id} className={card + " flex flex-col gap-2 p-4"}>
              <div className="flex items-center gap-2">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-full text-xl"
                  style={{ backgroundColor: t.color + "22" }}
                >
                  {t.emoji}
                </span>
                <div className="font-semibold">{t.name}</div>
              </div>
              <p className="line-clamp-3 text-xs leading-relaxed text-zinc-500">{t.identity}</p>
              <div className="mt-auto flex gap-2 pt-2">
                <button className={btnPrimary + " flex-1"} disabled={pending} onClick={() => start(t.id, "daily")}>
                  直接试聊
                </button>
                <button
                  className={btnGhost + " flex-1"}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const { id } = await duplicateCharacter(t.id);
                      router.push(`/characters/${id}`);
                    })
                  }
                >
                  复制为我的角色
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
