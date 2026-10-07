import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * TTS 磁盘缓存：key = sha256(供应商配置 + 文本)。
 * 同一句话反复试听/逐段重播不再打上游服务（GPT-SoVITS 一段要数秒）。
 * 超过上限按 mtime 清最旧。
 */

const CACHE_DIR = path.join(process.cwd(), "data", "tts-cache");
const CACHE_MAX_BYTES = 200 * 1024 * 1024;

export type TtsCacheConfig = {
  provider: string;
  baseUrl: string;
  lang: string;
  refAudio: string;
  promptText: string;
  promptLang: string;
  model: string;
  voice: string;
};

export function ttsCacheKey(cfg: TtsCacheConfig, text: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        cfg.provider,
        cfg.baseUrl,
        cfg.lang,
        cfg.refAudio,
        cfg.promptText,
        cfg.promptLang,
        cfg.model,
        cfg.voice,
        text,
      ]),
    )
    .digest("hex");
}

export function ttsCacheRead(key: string, ext: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(CACHE_DIR, `${key}${ext}`));
  } catch {
    return null;
  }
}

export function ttsCacheWrite(key: string, ext: string, data: Buffer) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${key}${ext}`), data);
    evict();
  } catch (err) {
    console.error("[tts] 缓存写入失败（忽略）:", err);
  }
}

function evict() {
  let files: { name: string; size: number; mtime: number }[];
  try {
    files = fs.readdirSync(CACHE_DIR).map((name) => {
      const st = fs.statSync(path.join(CACHE_DIR, name));
      return { name, size: st.size, mtime: st.mtimeMs };
    });
  } catch {
    return;
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  if (total <= CACHE_MAX_BYTES) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= CACHE_MAX_BYTES) break;
    try {
      fs.unlinkSync(path.join(CACHE_DIR, f.name));
      total -= f.size;
    } catch {
      /* 忽略 */
    }
  }
}

/** 设置页显示占用用 */
export function ttsCacheStats(): { files: number; bytes: number } {
  try {
    const names = fs.readdirSync(CACHE_DIR);
    let bytes = 0;
    for (const n of names) bytes += fs.statSync(path.join(CACHE_DIR, n)).size;
    return { files: names.length, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

export function ttsCacheClear(): void {
  try {
    for (const n of fs.readdirSync(CACHE_DIR)) fs.unlinkSync(path.join(CACHE_DIR, n));
  } catch {
    /* 忽略 */
  }
}
