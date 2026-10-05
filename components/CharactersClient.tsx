"use client";

import { useRef, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createCharacter, deleteCharacter, duplicateCharacter, importCharacter } from "@/lib/actions";
import { card, btnGhost, btnPrimary, badge } from "@/lib/ui";
import type { CharacterCard } from "@/lib/types";

type Row = CharacterCard & { worldbookId: string | null };

export default function CharactersClient({
  myCharacters,
  templates,
}: {
  myCharacters: Row[];
  templates: Row[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function createBlank() {
    startTransition(async () => {
      const { id } = await createCharacter(
        {
          name: "新角色",
          emoji: "🙂",
          color: "#6366f1",
          identity: "",
          speechStyle: "",
          values: "",
          boundaries: "",
          userAddressing: "",
          relationship: "",
          firstMessage: "",
          examples: [],
        },
        true,
      );
      router.push(`/characters/${id}`);
    });
  }

  function onImportFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      startTransition(async () => {
        try {
          const { id } = await importCharacter(String(reader.result));
          router.push(`/characters/${id}`);
        } catch (e) {
          alert(e instanceof Error ? e.message : "导入失败");
        }
      });
    };
    reader.readAsText(file, "utf-8");
  }

  const grid = (list: Row[], isTemplate: boolean) => (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {list.map((c) => (
        <div key={c.id} className={card + " flex flex-col gap-2 p-4"}>
          <div className="flex items-center gap-2">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-full text-xl"
              style={{ backgroundColor: c.color + "22" }}
            >
              {c.emoji}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-semibold">
                {c.name}
                {isTemplate && <span className={badge + " bg-amber-50 text-amber-600"}>模板</span>}
              </div>
              <div className="truncate text-xs text-zinc-400">{c.identity || "（未写身份）"}</div>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            {!isTemplate && (
              <Link href={`/characters/${c.id}`} className={btnGhost}>
                编辑
              </Link>
            )}
            {c.worldbookId && (
              <Link href={`/worldbooks/${c.id}`} className={btnGhost}>
                世界书
              </Link>
            )}
            {isTemplate ? (
              <button
                className={btnGhost}
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const { id } = await duplicateCharacter(c.id);
                    router.push(`/characters/${id}`);
                  })
                }
              >
                复制为我的角色
              </button>
            ) : (
              <button
                className={btnGhost + " ml-auto text-red-500"}
                disabled={pending}
                onClick={() => {
                  if (confirm(`删除角色「${c.name}」及其全部会话与世界书？不可恢复。`)) {
                    startTransition(() => deleteCharacter(c.id));
                  }
                }}
              >
                删除
              </button>
            )}
          </div>
        </div>
      ))}
      {list.length === 0 && (
        <p className="col-span-full rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center text-sm text-zinc-400">
          {isTemplate ? "没有模板角色。" : "还没有角色，点上方「新建角色」开始。"}
        </p>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="flex items-center gap-3">
        <h1 className="text-lg font-bold">我的角色</h1>
        <div className="ml-auto flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportFile(f);
              e.target.value = "";
            }}
          />
          <button className={btnGhost} disabled={pending} onClick={() => fileRef.current?.click()}>
            导入角色卡
          </button>
          <button className={btnPrimary} disabled={pending} onClick={createBlank}>
            ＋ 新建角色
          </button>
        </div>
      </section>
      {grid(myCharacters, false)}

      <section className="mt-2">
        <h2 className="mb-1 text-base font-semibold">模板角色中心</h2>
        <p className="mb-3 text-xs text-zinc-400">
          风月方法论：先拿模板聊满 10 轮找节奏 → 复制成自己的卡 → 每轮只改一个变量地压测（先闲聊，再冲突，最后长线）。
        </p>
        {grid(templates, true)}
      </section>
    </div>
  );
}
