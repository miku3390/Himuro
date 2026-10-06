import { createCharacter } from "@/lib/actions";
import { normalizeCard, readCharaFromPng } from "@/lib/stcard";

export const runtime = "nodejs";

/**
 * 角色卡导入（支持 SillyTavern PNG 卡 / V1V2V3 JSON 卡 / Himuro 卡）。
 * POST multipart/form-data: { file }
 * 返回 { id } 新角色 id。
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "缺少文件" }, { status: 400 });
    }
    if (file.size > 20 * 1024 * 1024) {
      return Response.json({ error: "文件超过 20MB" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());

    let jsonText: string | null;
    const isPng =
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (isPng) {
      jsonText = readCharaFromPng(bytes);
      if (!jsonText) {
        return Response.json(
          { error: "这张 PNG 里没有嵌入角色卡数据（缺少 chara/ccv3 文本块）" },
          { status: 400 },
        );
      }
    } else {
      jsonText = new TextDecoder("utf-8").decode(bytes);
    }

    let json: unknown;
    try {
      json = JSON.parse(jsonText);
    } catch {
      return Response.json({ error: "文件内容不是合法的角色卡 JSON" }, { status: 400 });
    }

    const card = normalizeCard(json);
    const { id } = await createCharacter(
      {
        name: card.name,
        emoji: "🎭",
        color: "#a78bfa",
        identity: card.identity,
        speechStyle: card.speechStyle,
        values: card.values,
        boundaries: card.boundaries,
        userAddressing: card.userAddressing,
        relationship: card.relationship,
        firstMessage: card.firstMessage,
        examples: card.examples,
        ttsRefAudio: "",
        ttsPromptText: "",
        ttsPromptLang: "",
        ttsLang: "",
        ttsRate: 0,
      },
      true,
    );
    return Response.json({ id, name: card.name, examples: card.examples.length });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "导入失败" },
      { status: 500 },
    );
  }
}
