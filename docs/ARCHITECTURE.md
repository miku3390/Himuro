# Himuro 架构说明

## 总览

```
浏览器（React 客户端组件）
  │  fetch SSE / Server Actions
  ▼
Next.js 16 单进程（App Router）
  ├── app/page.tsx                 会话首页
  ├── app/chat/[id]/page.tsx       聊天页
  ├── app/characters/…             角色列表 / 编辑器
  ├── app/worldbooks/[id]/page.tsx 世界书管理（路由按角色 ID，1:1）
  ├── app/settings/page.tsx        设置
  ├── app/api/chat/route.ts        聊天 SSE 流式接口（核心）
  ├── app/api/export/route.ts      导出 TXT/JSON
  └── lib/
      ├── db/schema.ts             Drizzle 表定义（唯一 schema 源）
      ├── db/index.ts              SQLite 单例 + 启动时自动迁移 + 种子
      ├── db/seed.ts               设置行 + 3 个模板角色
      ├── prompt.ts                Prompt 组装（纯函数，可单测）
      ├── memory.ts                三层记忆引擎 + 世界书命中
      ├── llm.ts                   OpenAI 兼容客户端（流式/补全/Embedding）+ mock 演示模型
      ├── settings.ts              设置读写
      ├── story.ts                 连载任务（钩子/提炼）
      ├── actions.ts               全部 Server Actions（CRUD）
      ├── tts.ts                   浏览器语音（client-only）
      ├── types.ts                 前后端共享类型/常量
      └── ui.ts                    Tailwind 类名常量（全站观感）
```

## 数据模型（SQLite，`data/himuro.db`）

- `characters` —— 角色卡：五件套字段 + relationship + firstMessage + examplesJson(JSON) + isTemplate
- `worldbooks` —— 每角色一本（characterId 关联）
- `wb_entries` —— 条目：category/title/content/keywordsJson/weight/sort/enabled
- `wb_versions` —— 整本快照（snapshotJson），变更前自动存，保留 30 份
- `conversations` —— mode(daily|story) / tier(light|quality) / chapter / summaryText / summarizedCount
- `messages` —— role/content/emotion(情绪目标)/starred(复盘星标)，idx 为会话内序号
- `msg_chunks` —— 向量块：messageId/chunk/vectorJson（JSON 数组存 float 向量）
- `settings` —— 单行表 id=1：三组模型配置 + 记忆参数 + TTS 参数

## 聊天一轮的完整流水线（app/api/chat/route.ts）

```
POST {conversationId, content, emotion}
 1. 用户消息入库
 2. 取最近 12 条原文（VERBATIM_WINDOW）
 3. matchWorldbook：最近 8 条做关键词扫描 → 权重 top6 条目
 4. searchVectorMemories：用户消息 Embedding → 余弦 top4（未配置则跳过）
 5. buildSystemPrompt：角色卡五件套 + 示例对话 + 滚动摘要 + 世界书命中 + 向量回忆 + 模式指令 + 情绪目标
 6. streamChat：OpenAI 兼容 /chat/completions stream=true，逐 token SSE 下发
    └─ baseUrl === "mock" → 内置演示模型（离线）
 7. 完成后：assistant 消息入库 → 双条向量入库 → maybeUpdateSummary（该摘要则摘要）
 8. SSE 事件：{t:"hits"} 命中面板 → {t:"tok"} 增量 → {t:"done"} 落库完成
```

客户端（components/ChatRoom.tsx）用 fetch + ReadableStream 解析 SSE，不依赖 EventSource（因为要 POST）。

## Prompt 模板（lib/prompt.ts）

所有注入块都是纯函数拼装，改措辞/加块只动这一个文件：

```
# 你的角色（五件套 + 关系）
# 对话示例（few-shot，3-5 组）
# 此前发生的事（滚动摘要）
# 世界书设定（本轮命中条目，【分类·标题】内容）
# 更早对话中的相关回忆（向量检索）
# 模式：日常聊天 | 连载剧情（章末【下一章钩子】要求）
# 本轮情绪目标
# 输出要求（保持入戏）
```

## 设计原则

1. **单进程零依赖**：SQLite 文件库、无 Redis、无 Docker；`npm run dev` 即全部。
2. **开箱可测**：mock 演示模型让全流程不需要 API Key。
3. **记忆透明**：命中了哪些条目、当前摘要是什么，聊天页右侧直接可见——调试人设/世界书不用猜。
4. **克制**：三层记忆到向量为止，不做 Agent/工具调用；运营功能（邀请/积分/签到）明确不做。
5. **中文优先**：UI、种子数据、prompt 全中文。
