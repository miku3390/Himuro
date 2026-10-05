"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { deleteEntry, ensureWorldbook, previewWorldbookHitsAction, rollbackWorldbook, saveEntry, type WbEntryInput } from "@/lib/actions";
import { WB_CATEGORIES, type WbCategory } from "@/lib/types";
import { badge, btnGhost, btnPrimary, card, input, label, textarea } from "@/lib/ui";

type Entry = {
  id: string;
  category: WbCategory;
  title: string;
  content: string;
  keywords: string[];
  weight: number;
  sort: number;
  enabled: boolean;
};

type Version = { id: string; note: string; createdAt: number };

const CATEGORY_STYLE: Record<WbCategory, string> = {
  人物: "bg-pink-50 text-pink-600",
  地点: "bg-sky-50 text-sky-600",
  事件: "bg-amber-50 text-amber-600",
  规则: "bg-violet-50 text-violet-600",
};

export default function WorldbookManager({
  character,
  worldbook,
  entries,
  versions,
}: {
  character: { id: string; name: string; emoji: string };
  worldbook: { id: string; name: string } | null;
  entries: Entry[];
  versions: Version[];
}) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<WbEntryInput | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewHits, setPreviewHits] = useState<{ category: string; title: string; weight: number }[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  if (!worldbook) {
    return (
      <div className={card + " mx-auto mt-10 max-w-md p-8 text-center"}>
        <p className="mb-4 text-sm text-zinc-500">这个角色还没有世界书。</p>
        <button
          className={btnPrimary}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await ensureWorldbook(character.id);
            })
          }
        >
          {pending ? "创建中…" : "创建世界书"}
        </button>
      </div>
    );
  }
  const wb = worldbook;

  function submit() {
    if (!editing) return;
    startTransition(async () => {
      await saveEntry(wb.id, editing);
      setEditing(null);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">
          {character.emoji} {character.name} · 世界书
        </h1>
        <span className="text-xs text-zinc-400">{wb.name}｜关键词命中后按权重注入，长对话不翻车靠结构不靠「它应该记得」</span>
        <div className="ml-auto flex gap-2">
          <button className={btnGhost} onClick={() => setShowVersions((v) => !v)}>
            版本历史（{versions.length}）
          </button>
          <button
            className={btnPrimary}
            onClick={() =>
              setEditing({ category: "事件", title: "", content: "", keywords: [], weight: 5, sort: entries.length, enabled: true })
            }
          >
            ＋ 新建条目
          </button>
        </div>
      </div>

      {/* 版本历史 */}
      {showVersions && (
        <section className={card + " p-4"}>
          <h2 className="mb-2 text-sm font-semibold">最近 30 次变更（可回滚）</h2>
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-xs">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-zinc-50">
                <span className="text-zinc-400">{new Date(v.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                <span className="text-zinc-600">{v.note}</span>
                <button
                  className="ml-auto text-indigo-500 hover:underline"
                  disabled={pending}
                  onClick={() => {
                    if (confirm("回滚到该版本？当前状态会先自动快照一份。")) {
                      startTransition(() => rollbackWorldbook(wb.id, v.id));
                    }
                  }}
                >
                  回滚到此
                </button>
              </li>
            ))}
            {versions.length === 0 && <li className="text-zinc-400">还没有变更记录。每次新增/修改/删除条目前都会自动存一份快照。</li>}
          </ul>
        </section>
      )}

      {/* 条目编辑表单 */}
      {editing && (
        <section className={card + " p-5"}>
          <h2 className="mb-3 text-sm font-semibold">{editing.id ? "编辑条目" : "新建条目"}</h2>
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <label className={label}>分类</label>
              <select
                className={input}
                value={editing.category}
                onChange={(e) => setEditing({ ...editing, category: e.target.value as WbCategory })}
              >
                {WB_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className={label}>标题（简短、可检索）</label>
              <input className={input} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </div>
            <div>
              <label className={label}>权重 {editing.weight}（越大越优先注入）</label>
              <input
                type="range"
                min={1}
                max={10}
                value={editing.weight}
                className="w-full accent-indigo-600"
                onChange={(e) => setEditing({ ...editing, weight: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="mt-4">
            <label className={label}>内容（一条只记一件事，别写长文）</label>
            <textarea className={textarea} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
          </div>
          <div className="mt-4">
            <label className={label}>触发关键词（用逗号分隔，出现在最近聊天里就会注入本条）</label>
            <input
              className={input}
              value={editing.keywords.join("，")}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  keywords: e.target.value.split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean),
                })
              }
              placeholder="海边，日出，周六"
            />
          </div>
          <div className="mt-4 flex gap-2">
            <button className={btnPrimary} disabled={pending || !editing.title.trim()} onClick={submit}>
              保存条目
            </button>
            <button className={btnGhost} onClick={() => setEditing(null)}>
              取消
            </button>
            <label className="ml-auto flex items-center gap-1.5 text-sm text-zinc-500">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                className="accent-indigo-600"
              />
              启用
            </label>
          </div>
        </section>
      )}

      {/* 命中预览 */}
      <section className={card + " p-4"}>
        <h2 className="mb-2 text-sm font-semibold">命中预览（调试触发词）</h2>
        <div className="flex gap-2">
          <input
            className={input}
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            placeholder='模拟一段用户输入，比如"周六去海边的话要几点起？"'
          />
          <button
            className={btnGhost}
            disabled={pending || !previewText.trim()}
            onClick={() =>
              startTransition(async () => {
                setPreviewHits(await previewWorldbookHitsAction(character.id, previewText));
              })
            }
          >
            测试命中
          </button>
        </div>
        {previewHits && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {previewHits.length === 0 ? (
              <span className="text-xs text-zinc-400">没有命中任何条目 —— 检查关键词是否覆盖了聊天常用词。</span>
            ) : (
              previewHits.map((h, i) => (
                <span key={i} className={badge + " " + (CATEGORY_STYLE[h.category as WbCategory] ?? "bg-zinc-100 text-zinc-500")}>
                  {h.category}·{h.title}（权重{h.weight}）
                </span>
              ))
            )}
          </div>
        )}
      </section>

      {/* 条目列表 */}
      <section className="flex flex-col gap-2">
        {entries.map((e) => (
          <div key={e.id} className={card + " flex items-start gap-3 p-4 " + (e.enabled ? "" : "opacity-50")}>
            <span className={badge + " mt-0.5 " + (CATEGORY_STYLE[e.category] ?? "bg-zinc-100")}>{e.category}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{e.title}</span>
                <span className={badge + " bg-zinc-100 text-zinc-500"}>权重 {e.weight}</span>
                {!e.enabled && <span className={badge + " bg-red-50 text-red-500"}>已停用</span>}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-zinc-600">{e.content}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {e.keywords.map((k) => (
                  <span key={k} className={badge + " bg-indigo-50 text-indigo-500"}>
                    {k}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <button
                className={btnGhost}
                onClick={() =>
                  setEditing({
                    id: e.id,
                    category: e.category,
                    title: e.title,
                    content: e.content,
                    keywords: e.keywords,
                    weight: e.weight,
                    sort: e.sort,
                    enabled: e.enabled,
                  })
                }
              >
                编辑
              </button>
              <button
                className={btnGhost + " text-red-500"}
                disabled={pending}
                onClick={() => {
                  if (confirm(`删除条目「${e.title}」？（会先自动存版本快照）`)) {
                    startTransition(() => deleteEntry(wb.id, e.id));
                  }
                }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        {entries.length === 0 && (
          <p className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center text-sm text-zinc-400">
            世界书还是空的。建议按 人物 / 地点 / 事件 / 规则 分条目记录，每条配 2–4 个触发关键词。
          </p>
        )}
      </section>

      <div className="text-center">
        <Link href={`/characters/${character.id}`} className="text-xs text-zinc-400 hover:text-indigo-500">
          ← 返回角色编辑
        </Link>
      </div>
    </div>
  );
}
