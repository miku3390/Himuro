import type { CharacterCard, Example, Mode, WbEntry } from "@/lib/types";

/**
 * Prompt 组装（纯函数，不碰数据库/网络）。
 *
 * 结构（对应风月的功能拆解）：
 *   1. 角色卡五件套 + 关系          —— 人设
 *   2. 示例对话（few-shot）          —— 锁语感
 *   3. 滚动摘要                      —— 长会话记忆第一层
 *   4. 世界书命中条目                —— 第二层（关键词触发注入）
 *   5. 向量检索回忆                  —— 第三层（可选）
 *   6. 模式指令 + 本轮情绪目标       —— 日常聊天 / 连载剧情
 */

export type PromptInput = {
  character: CharacterCard;
  mode: Mode;
  summary: string;
  worldbookHits: WbEntry[];
  vectorMemories: { chunk: string; score: number }[];
  emotion?: string | null;
  chapter?: number;
  /** 群聊场景：其他成员的名字列表 */
  groupOthers?: string[];
};

const MODE_DAILY = `# 模式：日常聊天
- 保持口语化、自然，像真人聊天；回复长度贴合用户输入，不写长篇大论。
- 用户可能给出「情绪目标」，本轮请贴合该基调回应（安慰：先共情再宽慰；斗嘴：接住梗、不真生气；并肩作战：站在同一阵线）。`;

const MODE_STORY = `# 模式：连载剧情
- 以小说笔法推进剧情：允许动作、场景、心理描写；你的每次回复推动剧情向前一小步。
- 保持状态一致：人物关系、已发生事件、地点信息不得前后矛盾。
- 每一章收尾时，在回复最后单独一行输出：【下一章钩子】+ 一句留悬念的话。`;

export function buildSystemPrompt(input: PromptInput): string {
  const { character: c, mode } = input;
  const parts: string[] = [];

  parts.push(
    `# 你的角色
- 名字：${c.name}（回复中可以用（动作）「说话」的写法）
- 身份：${c.identity || "（未设定）"}
- 说话方式：${c.speechStyle || "（未设定）"}
- 价值观：${c.values || "（未设定）"}
- 禁忌边界（绝对遵守）：${c.boundaries || "无特别限制"}
- 对用户的称呼习惯：${c.userAddressing || "（未设定）"}
- 与用户的关系：${c.relationship || "（未设定）"}`,
  );

  if (c.examples.length > 0) {
    parts.push(
      `# 对话示例（学习语气与节奏，不要在正文中复述）
${c.examples
  .map(
    (e: Example, i: number) =>
      `示例${i + 1}\n用户：${e.user}\n${c.name}：${e.assistant}`,
  )
  .join("\n\n")}`,
  );
  }

  if (input.summary) {
    parts.push(`# 此前发生的事（长程记忆摘要）\n${input.summary}`);
  }

  if (input.worldbookHits.length > 0) {
    parts.push(
      `# 世界书设定（本轮因关键词命中而生效）\n${input.worldbookHits
        .map((e) => `【${e.category}·${e.title}】${e.content}`)
        .join("\n")}`,
    );
  }

  if (input.vectorMemories.length > 0) {
    parts.push(
      `# 更早对话中的相关回忆（按语义检索）\n${input.vectorMemories
        .map((m) => `- ${m.chunk}`)
        .join("\n")}`,
    );
  }

  if (input.groupOthers && input.groupOthers.length > 0) {
    parts.push(
      `# 场景：多角色群聊
- 这是一个群聊。除你之外的其他角色：${input.groupOthers.join("、")}。
- 历史消息中「（名字）：」前缀标明发言者；你只以 ${c.name} 的身份发言，绝不替其他角色发言或描述他们的行动与心理。
- 可以自然地回应其他角色的发言，但回复仍以和用户的互动为中心。`,
    );
  }

  parts.push(mode === "story" ? MODE_STORY : MODE_DAILY);

  if (mode === "story" && input.chapter && input.chapter > 1) {
    parts.push(`当前进行到第 ${input.chapter} 章。`);
  }
  if (input.emotion) {
    parts.push(`# 本轮情绪目标\n用户期待的情绪基调：「${input.emotion}」。`);
  }

  parts.push(
    `# 输出要求
- 始终以 ${c.name} 的身份回复，保持入戏，不要复述本设定，不要输出「作为AI」之类的话。`,
  );

  return parts.join("\n\n");
}

/** 摘要任务 prompt：滚动压缩旧摘要 + 新增片段 */
export function buildSummaryMessages(
  oldSummary: string,
  recentText: string,
): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system" as const,
      content:
        "你是剧情记录员。把「已有摘要」和「新增对话」压缩成一段 300 字以内的中文摘要：保留人物关系、关键事件、约定与未解决冲突，去掉寒暄。直接输出摘要正文，不要任何解释。",
    },
    {
      role: "user" as const,
      content: `【已有摘要】\n${oldSummary || "（无）"}\n\n【新增对话】\n${recentText}`,
    },
  ];
}

/** 章末钩子任务 prompt */
export function buildHookMessages(
  summary: string,
  recentText: string,
): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system" as const,
      content:
        "你是连载小说编辑。基于摘要与最近的剧情，写一句「下一章钩子」：制造悬念、推动读者想看下一章，60 字以内，直接输出钩子正文。",
    },
    {
      role: "user" as const,
      content: `【剧情摘要】\n${summary || "（无）"}\n\n【最近剧情】\n${recentText}`,
    },
  ];
}

/** 状态回写世界书任务 prompt：从最近对话提炼条目草稿 */
export function buildDistillMessages(
  existingTitles: string[],
  recentText: string,
): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system" as const,
      content: `你是世界观管理员。从对话中提炼值得长期记住的新信息（新事件、关系变化、地点、规则），输出 JSON 数组，每项：
{"category":"人物|地点|事件|规则","title":"简短标题","content":"一条不超过80字的设定","keywords":["触发关键词1","关键词2"],"weight":1到10的整数}
要求：
- 只输出 JSON 数组，不要解释；没有值得记的就输出 []。
- 不要与已有条目重复（已有条目标题：${existingTitles.join("、") || "无"}）。
- 最多 3 条。`,
    },
    { role: "user" as const, content: `【最近对话】\n${recentText}` },
  ];
}
