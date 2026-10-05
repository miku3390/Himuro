import {
  sqliteTable,
  text,
  integer,
  real,
} from "drizzle-orm/sqlite-core";

/**
 * Himuro 数据模型
 *
 * 约定：
 * - 所有主键用 crypto.randomUUID() 生成的字符串
 * - 布尔值用 integer 0/1（SQLite 惯例）
 * - JSON 结构（示例对话、关键词、向量、快照）存 text，读取时 JSON.parse
 */

/** 角色卡：对应风月「五件套 + 关系 + 开场白 + 示例对话」 */
export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull().default("🙂"),
  color: text("color").notNull().default("#6366f1"),
  /** 身份一句话 */
  identity: text("identity").notNull().default(""),
  /** 说话方式（语气/口癖） */
  speechStyle: text("speech_style").notNull().default(""),
  /** 价值观 */
  values: text("values").notNull().default(""),
  /** 禁忌边界 */
  boundaries: text("boundaries").notNull().default(""),
  /** 对用户的称呼习惯 */
  userAddressing: text("user_addressing").notNull().default(""),
  /** 与用户的关系 */
  relationship: text("relationship").notNull().default(""),
  /** 开场白：新建会话时的第一条角色消息 */
  firstMessage: text("first_message").notNull().default(""),
  /** 示例对话 [{ user, assistant }] x 3-5，锁定语感 */
  examplesJson: text("examples_json").notNull().default("[]"),
  /** 模板角色：只用来开新卡/试聊，不出现在普通列表 */
  isTemplate: integer("is_template").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** 世界书：每个角色一本（1:1），服务其所有会话 */
export const worldbooks = sqliteTable("worldbooks", {
  id: text("id").primaryKey(),
  characterId: text("character_id").notNull(),
  name: text("name").notNull().default("世界书"),
  createdAt: integer("created_at").notNull(),
});

/** 世界书条目：人物 / 地点 / 事件 / 规则，关键词 + 权重触发 */
export const wbEntries = sqliteTable("wb_entries", {
  id: text("id").primaryKey(),
  worldbookId: text("worldbook_id").notNull(),
  category: text("category").notNull().default("事件"), // 人物|地点|事件|规则
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  /** 触发关键词 JSON string[] */
  keywordsJson: text("keywords_json").notNull().default("[]"),
  /** 权重 1-10，越高越优先注入 */
  weight: integer("weight").notNull().default(5),
  /** 同权重时的固定排序 */
  sort: integer("sort").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** 世界书版本快照：每次结构化保存时整本存一份，可回滚 */
export const wbVersions = sqliteTable("wb_versions", {
  id: text("id").primaryKey(),
  worldbookId: text("worldbook_id").notNull(),
  note: text("note").notNull().default(""),
  /** 整本条目快照 JSON */
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** 会话 */
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  characterId: text("character_id").notNull(),
  title: text("title").notNull().default("新的会话"),
  /** daily=日常聊天 story=连载剧情 */
  mode: text("mode").notNull().default("daily"),
  /** light=轻量档 quality=高质量档 */
  tier: text("tier").notNull().default("light"),
  /** 连载模式当前章节号 */
  chapter: integer("chapter").notNull().default(1),
  /** 滚动摘要（长会话记忆第一层） */
  summaryText: text("summary_text").notNull().default(""),
  /** 已被摘要覆盖的消息条数 */
  summarizedCount: integer("summarized_count").notNull().default(0),
  /** 群聊发言策略：mention=谁被@谁答 rotate=依次发言 all=全员发言；null=非群聊 */
  groupStrategy: text("group_strategy"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** 群聊成员：会话存在成员行即为群聊（1:1 会话无成员行） */
export const convMembers = sqliteTable("conv_members", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  characterId: text("character_id").notNull(),
  /** 发言顺序（rotate/all 策略用） */
  sort: integer("sort").notNull().default(0),
  joinedAt: integer("joined_at").notNull(),
});

/** 消息 */
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  idx: integer("idx").notNull(),
  role: text("role").notNull(), // user | assistant
  content: text("content").notNull(),
  /** 群聊中的发言人（assistant 消息）；null = 单聊角色或用户消息 */
  characterId: text("character_id"),
  /** 用户本轮的情绪目标（日常模式），如：安慰/斗嘴/并肩作战/自定义 */
  emotion: text("emotion"),
  /** 复盘星标：标出满意的回复，用于回写角色卡 */
  starred: integer("starred").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

/** 向量块：长会话记忆第三层（可选，配置了 Embedding 才写入） */
export const msgChunks = sqliteTable("msg_chunks", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  messageId: text("message_id").notNull(),
  chunk: text("chunk").notNull(),
  vectorJson: text("vector_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** 全局设置：单行表（id=1） */
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  lightBaseUrl: text("light_base_url").notNull().default("mock"),
  lightApiKey: text("light_api_key").notNull().default(""),
  lightModel: text("light_model").notNull().default("演示模型"),
  qualityBaseUrl: text("quality_base_url").notNull().default("mock"),
  qualityApiKey: text("quality_api_key").notNull().default(""),
  qualityModel: text("quality_model").notNull().default("演示模型"),
  /** Embedding 可不配置，向量记忆层自动停用 */
  embedBaseUrl: text("embed_base_url").notNull().default(""),
  embedApiKey: text("embed_api_key").notNull().default(""),
  embedModel: text("embed_model").notNull().default(""),
  /** 每累计多少条未摘要消息触发一次滚动摘要 */
  summaryEveryTurns: integer("summary_every_turns").notNull().default(10),
  /** 世界书单轮最大注入条数 */
  wbMaxHits: integer("wb_max_hits").notNull().default(6),
  /** 向量检索注入条数 */
  vecTopK: integer("vec_top_k").notNull().default(4),
  /** TTS（浏览器语音）参数 */
  ttsVoice: text("tts_voice").notNull().default(""),
  ttsRate: real("tts_rate").notNull().default(1),
  ttsPitch: real("tts_pitch").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});
