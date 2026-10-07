import "server-only";
import { deflateSync } from "node:zlib";

/**
 * PNG 最小实现（零依赖）：够「生成渐变底图 + 注入 tEXt 角色卡块」用。
 * 格式：8 字节签名 + 若干 chunk（len + type + data + crc32）。
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function isPng(bytes: Uint8Array): boolean {
  for (let i = 0; i < PNG_SIG.length; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

function parseHex(hex: string): [number, number, number] {
  const h = (hex || "").replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (/^[0-9a-fA-F]{6}$/.test(full)) {
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  return [99, 102, 241]; // 默认 indigo
}

/** 角色色垂直渐变底图（RGB 真彩，无压缩依赖） */
export function gradientPng(width: number, height: number, topHex: string, bottomHex: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const [tr, tg, tb] = parseHex(topHex);
  const [br, bg, bb] = parseHex(bottomHex);
  const raw = Buffer.alloc(height * (1 + width * 3));
  let off = 0;
  for (let y = 0; y < height; y++) {
    raw[off++] = 0; // filter: none
    const t = height > 1 ? y / (height - 1) : 0;
    const r = Math.round(tr + (br - tr) * t);
    const g = Math.round(tg + (bg - tg) * t);
    const b = Math.round(tb + (bb - tb) * t);
    for (let x = 0; x < width; x++) {
      raw[off++] = r;
      raw[off++] = g;
      raw[off++] = b;
    }
  }
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 在 IHDR 之后插入 tEXt chunk（keyword\x00value，value 需为 latin1 可编码——base64 满足） */
export function injectTextChunk(png: Buffer, keyword: string, value: string): Buffer {
  if (!isPng(png)) throw new Error("不是合法的 PNG 文件");
  const textData = Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.alloc(1),
    Buffer.from(value, "latin1"),
  ]);
  const ihdrEnd = 8 + (4 + 4 + 13 + 4); // 签名 + IHDR chunk（len+type+data+crc）
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk("tEXt", textData), png.subarray(ihdrEnd)]);
}
