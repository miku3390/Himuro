import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";

const TIMEOUT_MS = 240_000;

/**
 * 自部署 TTS 代理：浏览器 → /api/tts → GPT-SoVITS / OpenAI 兼容服务。
 * 绕开 CORS，密钥/内网地址不出服务端。
 *
 * 请求：{ text: string }
 * 返回：audio/wav（gptsovits）或按供应商格式的音频字节流；provider=browser 返回 400。
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { text?: string };
  const text = (body.text ?? "").trim().slice(0, 1000);
  if (!text) return Response.json({ error: "缺少 text" }, { status: 400 });

  const s = getSettings();
  const tts = s.tts;

  try {
    if (tts.provider === "gptsovits") {
      if (!tts.baseUrl || !tts.refAudio) {
        return Response.json({ error: "GPT-SoVITS 未配置完整（需要 Base URL 与参考音频路径）" }, { status: 400 });
      }
      const upstream = await fetch(tts.baseUrl.replace(/\/+$/, "") + "/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          text_lang: tts.lang || "zh",
          ref_audio_path: tts.refAudio,
          prompt_text: tts.promptText,
          prompt_lang: tts.promptLang || "ja",
          media_type: "wav",
          streaming: false,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        return Response.json(
          { error: `GPT-SoVITS 返回 ${upstream.status}: ${detail.slice(0, 300)}` },
          { status: 502 },
        );
      }
      const audio = await upstream.arrayBuffer();
      return new Response(audio, {
        headers: {
          "content-type": "audio/wav",
          "cache-control": "no-store",
        },
      });
    }

    if (tts.provider === "openai") {
      if (!tts.baseUrl || !tts.model) {
        return Response.json({ error: "OpenAI 兼容 TTS 未配置完整（需要 Base URL 与模型名）" }, { status: 400 });
      }
      // 自部署包装服务通常无需鉴权；指向 openai.com 时复用轻量档的 Key
      const needsKey = /openai\.com/i.test(tts.baseUrl);
      const upstream = await fetch(tts.baseUrl.replace(/\/+$/, "") + "/audio/speech", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(needsKey && s.light.apiKey ? { authorization: `Bearer ${s.light.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: tts.model,
          input: text,
          voice: tts.voice || "alloy",
          response_format: "mp3",
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        return Response.json(
          { error: `TTS 服务返回 ${upstream.status}: ${detail.slice(0, 300)}` },
          { status: 502 },
        );
      }
      const audio = await upstream.arrayBuffer();
      return new Response(audio, {
        headers: {
          "content-type": "audio/mpeg",
          "cache-control": "no-store",
        },
      });
    }

    return Response.json({ error: "当前 TTS 供应商为浏览器内置，无需服务端代理" }, { status: 400 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
