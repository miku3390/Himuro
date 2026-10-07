/**
 * TTS 长文本切句（纯函数，浏览器/Node 通用，smoke 可直接测）。
 *
 * GPT-SoVITS 对长文本合成质量差且慢，逐句合成 + 顺序播放是社区通用做法：
 * - 先按句末标点（。！？!?…；;）与换行切，保留标点
 * - 过短片段（<8 字）并入相邻句，避免一字一顿
 * - 仍超长的句子在逗号/顿号/空格处二次切，兜底按 maxLen 硬切
 */

export function splitSentences(text: string, maxLen = 100): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const raw = normalized
    .split(/(?<=[。！？!?…;；\n])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 过短片段并入相邻句
  const merged: string[] = [];
  for (const seg of raw) {
    const last = merged.at(-1);
    if (last && (last.length < 8 || seg.length < 8) && last.length + seg.length <= maxLen) {
      merged[merged.length - 1] = last + seg;
    } else {
      merged.push(seg);
    }
  }

  const out: string[] = [];
  for (const seg of merged) {
    if (seg.length <= maxLen) {
      out.push(seg);
      continue;
    }
    let rest = seg;
    while (rest.length > maxLen) {
      const win = rest.slice(0, maxLen);
      const cut = Math.max(
        win.lastIndexOf("，"),
        win.lastIndexOf(","),
        win.lastIndexOf("、"),
        win.lastIndexOf("；"),
        win.lastIndexOf(";"),
        win.lastIndexOf(" "),
      );
      const at = cut > maxLen * 0.4 ? cut + 1 : maxLen;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    if (rest.trim()) out.push(rest.trim());
  }
  return out.filter(Boolean);
}
