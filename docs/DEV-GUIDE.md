# Himuro 迭代指南（写给下一个开发者 —— 无论是你还是 AI）

改代码前先读：README（功能对照）、docs/ARCHITECTURE.md（结构与流水线）。本文只讲「怎么改」。

## 环境准备

```bash
npm install
npm run dev        # http://localhost:3000，热更新
npm run lint && npx tsc --noEmit   # 提交前跑这两个
```

- 数据库 `data/himuro.db` 首次启动自动创建 + 迁移 + 种子。改了 `lib/db/schema.ts` 后跑 `npx drizzle-kit generate` 生成迁移文件（提交进仓库），下次启动自动应用。
- 重置出厂：停服 → 删 `data/` → 重启。
- 没配 API Key 也能测全流程（设置页保持 mock 演示模型）。

## 常见改动怎么下手

### 1. 给角色卡加一个字段（例：`hobby 兴趣爱好`）

1. `lib/db/schema.ts` → `characters` 表加 `hobby: text("hobby").notNull().default("")`
2. `npx drizzle-kit generate`
3. `lib/types.ts` → `CharacterCard` 加 `hobby: string`
4. `lib/memory.ts` → `getCharacterCard()` 读取处加一行映射
5. `lib/actions.ts` → `upsertCharacterValues()` 加字段；`CharacterInput` 随 `CharacterCard` 自动带上
6. `lib/prompt.ts` → `buildSystemPrompt()` 的「# 你的角色」块加一行 `- 兴趣爱好：${c.hobby}`
7. `components/CharacterEditor.tsx` → 加表单项（`lib/ui.ts` 的 `input/textarea/label` 直接用）
8. 页面取数处（`app/page.tsx`、`app/characters/page.tsx` 的 `mapCard`）补字段

### 2. 调 Prompt / 记忆策略

- 全部在 `lib/prompt.ts`（措辞与结构）和 `lib/memory.ts`（窗口大小、命中数、阈值、摘要触发节奏）。
- 调试方法：聊天页右侧面板看「本轮世界书命中」和「摘要」；世界书管理页有命中预览。
- 改完用 mock 模型跑一轮，确认 SSE 事件顺序不变（hits → tok → done）。

### 3. 换/加 TTS 供应商

`lib/tts.ts` 是唯一的语音层（client-only）。Phase 2 接 GPT-SoVITS/CosyVoice 时：
- 保持 `speak(text, opts)` / `stopSpeak()` 签名不变，内部改为请求自部署服务的音频流（`<audio>` 播放）；
- 设置页加 provider 下拉与服务地址字段（存 `settings` 表新列）；
- 聊天页调用处无需改动。

### 4. 加一个页面

1. `app/<route>/page.tsx`（server component 取数，`export const dynamic = "force-dynamic"`）
2. 交互多的话拆 client 组件到 `components/`，服务端逻辑一律走 `lib/actions.ts` 的 Server Actions（带 `"use server"`，改完记得 `revalidatePath`）
3. 顶栏导航在 `app/layout.tsx`

### 5. 加 AI 任务（类似钩子/提炼）

参考 `lib/story.ts`：prompt builder 放 `lib/prompt.ts`，任务函数放 `lib/story.ts`（非流式用 `chatComplete`），聊天页侧栏加按钮调用。让模型输出 JSON 时，在 prompt 里要求纯 JSON 并做 `indexOf("[")` 容错解析（现有 `distillWorldbookDraft` 是范本）。

## 代码约定

- 注释写「为什么」，不写「做了什么」；核心模块（prompt/memory/llm）的文件头有一段职责说明。
- 所有用户可见文案用中文；类名统一从 `lib/ui.ts` 引，别手写散落的全局样式。
- ID 用 `crypto.randomUUID()`；时间戳 `Date.now()` 毫秒整型。
- 原生模块：`better-sqlite3` 必须留在 `next.config.ts` 的 `serverExternalPackages` 里，删了会构建报错。
- 仓库里的 `AGENTS.md` 是 Next.js 官方给 AI 助手的提示（Next 16 与旧版差异大，写代码前按它的指引查 `node_modules/next/dist/docs/`）。

## 已知边界（改之前别踩）

- `serverExternalPackages` / Node runtime：所有碰数据库的代码必须是 server 侧（`"server-only"` 已加在 db/memory/settings/llm/story/actions 上，client 误 import 会直接报错）。
- `wb_versions` 快照是整本 JSON，条目多了会变大——保留 30 份的上限写在 `snapshotWorldbook()`。
- 示例对话上限 5 组、超过淘汰最早的：这个口径来自风月官方，写在 `writeBackExample()` 和角色编辑器。
- 聊天 SSE 是 POST + ReadableStream，别改成 EventSource（不支持 POST）。
