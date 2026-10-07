import { getCharacterCard } from "@/lib/memory";
import { gradientPng, injectTextChunk, isPng } from "@/lib/png";
import { toSillyTavernV2 } from "@/lib/stcard";

export const runtime = "nodejs";

/**
 * 角色卡 PNG 导出（SillyTavern 通用格式）：
 * POST { characterId, baseImage? }
 *   baseImage = dataURL（image/png;base64,…）作为底图；缺省用角色色渐变底图。
 * 卡 JSON 按 V2 规格序列化后 base64，写进 tEXt chunk（keyword="chara"）。
 * 返回 image/png 附件。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { characterId?: string; baseImage?: string };
  const card = getCharacterCard(body.characterId ?? "");
  if (!card) return Response.json({ error: "角色不存在" }, { status: 404 });

  let base: Buffer;
  if (body.baseImage) {
    const m = /^data:image\/png;base64,([\s\S]+)$/.exec(body.baseImage);
    if (!m) return Response.json({ error: "底图必须是 PNG 的 dataURL" }, { status: 400 });
    base = Buffer.from(m[1], "base64");
    if (base.length > 8 * 1024 * 1024) {
      return Response.json({ error: "底图超过 8MB" }, { status: 400 });
    }
    if (!isPng(base)) return Response.json({ error: "底图不是合法的 PNG 文件" }, { status: 400 });
  } else {
    // 角色色 → 压暗 45% 的垂直渐变
    base = gradientPng(512, 768, card.color, shade(card.color, 0.45));
  }

  const json = toSillyTavernV2({
    name: card.name,
    identity: card.identity,
    speechStyle: card.speechStyle,
    values: card.values,
    boundaries: card.boundaries,
    userAddressing: card.userAddressing,
    relationship: card.relationship,
    firstMessage: card.firstMessage,
    examples: card.examples,
  });
  const png = injectTextChunk(
    base,
    "chara",
    Buffer.from(JSON.stringify(json), "utf8").toString("base64"),
  );

  const filename = `${card.name}-SillyTavern卡.png`;
  const pngBody = new ArrayBuffer(png.byteLength);
  new Uint8Array(pngBody).set(png);
  return new Response(pngBody, {
    headers: {
      "content-type": "image/png",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

/** 颜色向黑色压缩 shade 比例，得到渐变的暗端 */
function shade(hex: string, amount: number): string {
  const h = (hex || "").replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return "#1e1b4b";
  const ch = [0, 2, 4].map((i) => Math.round(parseInt(full.slice(i, i + 2), 16) * (1 - amount)));
  return "#" + ch.map((v) => v.toString(16).padStart(2, "0")).join("");
}
