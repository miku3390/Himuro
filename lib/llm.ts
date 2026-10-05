import "server-only";
import type { ModelConfig, Mode } from "@/lib/types";

/**
 * OpenAI 兼容 LLM 客户端（fetch 直连，不依赖 SDK）。
 *
 * baseUrl === "mock" 时走内置演示模型：不联网、无需 API Key，
 * 保证没有任何配置时全流程可用、可测试。
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type MockHint = {
  kind: "chat" | "summary" | "hook" | "distill";
  characterName?: string;
  userText?: string;
  mode?: Mode;
};

export type StreamOptions = {
  config: ModelConfig;
  messages: ChatMessage[];
  mockHint?: MockHint;
  temperature?: number;
};

const TIMEOUT_MS = 120_000;

/* ---------------------------------- mock ---------------------------------- */

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const MOCK_ACTIONS = [
  "微微歪了歪头",
  "把发梢绕在指尖",
  "往前凑近了一点",
  "抿了口手里的热茶",
  "视线在你脸上停了两秒",
];

function mockChatReply(hint: MockHint): string {
  const name = hint.characterName || "角色";
  const userText = (hint.userText || "").slice(0, 60) || "……";
  const action = MOCK_ACTIONS[hash(userText) % MOCK_ACTIONS.length];
  const mode = hint.mode === "story" ? "story" : "daily";

  if (mode === "story") {
    return `（${name}${action}，似乎在认真掂量你刚才的话。）\n\n「${userText}吗……」她轻声重复了一遍，像是要把这四个字咬出别的味道来。「有点意思。那便说定了——今夜之事，你我谁也不许先退缩。」\n\n窗外风声掠过，烛火晃了一晃。（剧情继续：你可以描述你的行动，或问我周围的动静。）`;
  }
  return `（${name}${action}。）\n\n「${userText}……嗯，我听到了。」她点点头，语气认真起来，「不过依我看，这事没你想的那么糟。先把眼前这一步走稳，剩下的，不是还有我陪你一起嘛。」\n\n「所以——接下来你想做什么？」`;
}

function mockSummary(oldSummary: string): string {
  const prev = oldSummary ? oldSummary.slice(0, 80) + "……" : "（此前无摘要）";
  return `【摘要】${prev} 之后双方继续交谈：气氛缓和，彼此更熟悉了一些，约定的事情仍在推进，暂无新的重大冲突。`;
}

function mockHook(): string {
  return "她忽然停下脚步，望向远处某一处亮起的灯火——那里本不该有人。「……来得比预想的早。」下一章：不速之客带着一封信登门，信封上的火漆印正是他们一路寻找的那个记号。";
}

function mockDistill(): string {
  return JSON.stringify(
    [
      {
        category: "事件",
        title: "最近的约定",
        content: "双方在近期的交谈中确认了此前的约定，并商定按计划推进。",
        keywords: ["约定", "计划"],
        weight: 7,
      },
    ],
    null,
    2,
  );
}

function mockText(hint: MockHint): string {
  switch (hint.kind) {
    case "summary":
      return mockSummary(hint.userText || "");
    case "hook":
      return mockHook();
    case "distill":
      return mockDistill();
    default:
      return mockChatReply(hint);
  }
}

async function* mockStream(text: string): AsyncGenerator<string> {
  // 按小片切块流出，模拟真实打字节奏，便于验证前端流式渲染
  const chunks = text.match(/[\s\S]{1,6}/g) ?? [text];
  for (const c of chunks) {
    await new Promise((r) => setTimeout(r, 18));
    yield c;
  }
}

/* ------------------------------ OpenAI 兼容 ------------------------------- */

async function postJson(
  config: ModelConfig,
  path: string,
  body: unknown,
): Promise<Response> {
  const url = config.baseUrl.replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM 请求失败 ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

/** 流式对话：逐 token yield 增量文本 */
export async function* streamChat(opts: StreamOptions): AsyncGenerator<string> {
  const { config, messages, mockHint } = opts;
  if (config.baseUrl === "mock") {
    yield* mockStream(mockText(mockHint ?? { kind: "chat" }));
    return;
  }

  const res = await postJson(config, "/chat/completions", {
    model: config.model,
    messages,
    stream: true,
    temperature: opts.temperature ?? 0.8,
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) {
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta: string | undefined =
            json?.choices?.[0]?.delta?.content ?? undefined;
          if (delta) yield delta;
        } catch {
          // 忽略无法解析的心跳/注释块
        }
      }
    }
  }
}

/** 非流式补全：用于摘要、钩子、提炼等内部任务 */
export async function chatComplete(
  config: ModelConfig,
  messages: ChatMessage[],
  mockHint?: MockHint,
): Promise<string> {
  if (config.baseUrl === "mock") {
    return mockText(mockHint ?? { kind: "summary" });
  }
  const res = await postJson(config, "/chat/completions", {
    model: config.model,
    messages,
    stream: false,
    temperature: 0.6,
  });
  const json = await res.json();
  const content: string | undefined = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 返回内容为空");
  return content;
}

/** Embedding（向量记忆层用）；未配置返回 null */
export async function embedTexts(
  config: { baseUrl: string; apiKey: string; model: string },
  texts: string[],
): Promise<number[][] | null> {
  if (!config.baseUrl || !config.model || config.baseUrl === "mock") return null;
  const res = await postJson(config, "/embeddings", {
    model: config.model,
    input: texts,
  });
  const json = await res.json();
  const list = json?.data as { embedding: number[] }[] | undefined;
  if (!Array.isArray(list)) return null;
  return list.map((d) => d.embedding);
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
