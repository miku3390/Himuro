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
  ├── app/api/chat/route.ts        聊天 SSE 流式接口（核心；支持 reroll 重Roll）
  ├── app/api/export/route.ts      导出 TXT/JSON
  ├── app/api/import/card/route.ts 角色卡导入（SillyTavern PNG/V1V2V3 JSON/Himuro 卡）
  ├── app/api/tts/route.ts         TTS 服务端代理（gptsovits / openai 兼容）
  └── lib/
      ├── db/schema.ts             Drizzle 表定义（唯一 schema 源）
      ├── db/index.ts              SQLite 单例 + 启动时自动迁移 + 种子
      ├── db/seed.ts               设置行 + 3 个模板角色
      ├── prompt.ts                Prompt 组装（纯函数，可单测）
      ├── memory.ts                三层记忆引擎 + 世界书命中
      ├── llm.ts                   OpenAI 兼容客户端（流式/补全/Embedding）+ mock 演示模型
      ├── stcard.ts                SillyTavern 卡解析（PNG tEXt chunk / V1V2V3 归一化 / 宏替换）
      ├── tts.ts                   TTS 客户端统一入口（browser=Web Speech / gptsovits+openai=调 /api/tts 播音频）
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
POST {conversationId, content, emotion}            普通发送
POST {conversationId, reroll:true, rerollMessageId?} 重Roll（删旧回复重新生成；
                                                     末尾是用户消息时直接续写——编辑重发用）
 1. 用户消息入库（reroll 则改为删除被替换的回复，含向量块）
 2. 取最近 12 条原文（VERBATIM_WINDOW）
 3. matchWorldbook：最近 8 条做关键词扫描 → 权重 top6 条目
 4. searchVectorMemories：用户消息 Embedding → 余弦 top4（未配置则跳过）
 5. buildSystemPrompt：角色卡五件套 + 示例对话 + 滚动摘要 + 世界书命中 + 向量回忆 + 模式指令 + 情绪目标
 6. streamChat：OpenAI 兼容 /chat/completions stream=true，逐 token SSE 下发
    └─ baseUrl === "mock" → 内置演示模型（离线）
 7. 完成后：assistant 消息入库 → 双条向量入库 → maybeUpdateSummary（该摘要则摘要）
 8. SSE 事件：{t:"hits"} 命中面板 → {t:"tok"} 增量 → {t:"done", messageId, userMessageId} 落库完成
    └─ userMessageId 必须回传：前端用它替换乐观插入的临时消息 id，否则后续「编辑/删除」找不到消息
```

### 群聊事件流（同一接口，会话成员 ≥2 时自动切换）

```
{t:"speakers", speakers:[{characterId,name,emoji}]}   本轮发言者名单（策略选出）
  → 每位发言者依次：
    {t:"speaker", ...} → {t:"hits", speaker} → {t:"tok"}* → {t:"speaker_done", messageId}
  → {t:"done", userMessageId, summary}
```

## 群聊机制（lib/group.ts + lib/chatEngine.ts）

- **判定**：会话在 `conv_members` 表里有 ≥2 行即为群聊（1:1 会话不写成员表）；消息上的 `characterId` 标记发言人。
- **发言策略**（`conversations.groupStrategy`，聊天页顶栏可切换）：
  - `mention 谁被@谁答`（默认）：消息里点名（全名或去「（副本）」后缀的基础名）的成员回应；没人被点名则轮换下一位
  - `rotate 依次发言`：上一位发言者的下一位（循环）
  - `all 全员发言`：全部成员按 sort 顺序
- **同轮多角色**：被选中的发言者按顺序**逐个**生成（lib/chatEngine.ts 每次重新读消息窗口，后发言者能看到前者本轮的发言）；system prompt 附「群聊场景」块 + 历史消息带「（名字）：」前缀，禁止替其他角色发言。
- **记忆**：世界书命中按成员用自己的世界书独立计算；滚动摘要与向量库全群共享。
- **前端坑位**：React updater 延迟执行——speaker_done 处理里闭包引用的累加变量必须先快照（`const spokenText = speakerAcc`）再清零，否则消息内容为空串（已踩过的坑，见 ChatRoom.tsx 注释）。

## TTS 链路（lib/tts.ts + app/api/tts/route.ts）

```
聊天页「试听」/ 设置页「试听」
  → lib/tts.ts speak()：读 localStorage 的 himuro-tts-provider
     ├─ browser → Web Speech API（离线，音色/语速/音调可调）
     └─ gptsovits / openai → POST /api/tts {text, characterId?}
          → 服务端按 settings.tts.* 组装上游请求（GPT-SoVITS POST /tts JSON；
            OpenAI 兼容 POST /audio/speech）→ 音频字节流回传 → <audio> 播放
```

- **角色级音色**（v1.4）：characters 表有 ttsRefAudio/ttsPromptText/ttsPromptLang/ttsLang 四个字段
  （角色编辑器「角色语音」区块），/api/tts 带 characterId 时逐字段覆盖全局配置，空字段回退。
  GPT-SoVITS 换参考音频 = 换音色；给角色训练好专属音色后填一个路径即可。聊天页试听自动带上
  发言人的 characterId（群聊里各角色各说各的声）。

- 供应商参数存 `settings` 表（保存时同步 localStorage 供聊天页免查询读取）。
- 本机 WSL 预装了 GPT-SoVITS（忍野扇音色 v4 权重），启动命令：`wsl bash ~/GPT-SoVITS/start_api.sh`（监听 0.0.0.0:9880）。依赖的 NLTK 数据（cmudict、averaged_perceptron_tagger*）已在 `~/nltk_data` 就位。
- 种子默认 provider=gptsovits 并预填扇的参考音频；服务未启动时试听会报错，可切回 browser。
- Phase 3：按角色换参考音频（GPT-SoVITS 换 ref 即换音色）、批量导出、逐句高潮配音。

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
