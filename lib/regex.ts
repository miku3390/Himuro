import { compileRegex, type RegexRule, type RegexTarget } from "@/lib/types";

/**
 * 正则后处理（酒馆 Regex 对等）
 *
 * 应用时机（刻意选「入库前」而不是「读出时过滤」）：
 *   - 存进库的就是最终文本，显示/导出/重Roll上下文/向量入库四处保持一致；
 *   - 代价是切换规则不会追溯改历史文本——重Roll 同一句话即可再生一份。
 *
 * input 目标：作用于用户消息（发送前、落库前）；result 为空时保留原文，避免空消息卡死流程。
 * output 目标：作用于角色回复（生成完、落库前），SSE 用 refine 事件把改写结果同步给前端。
 */
export function applyRegexRules(text: string, target: RegexTarget, rules: RegexRule[]): string {
  let out = text;
  for (const rule of rules) {
    if (rule.target !== target) continue;
    const re = compileRegex(rule);
    if (!re) continue;
    out = out.replace(re, rule.replacement);
  }
  // 空串说明某条规则配置得过于激进（如整句被清空）：宁可保留原文也不丢消息
  return out.trim() ? out : text;
}
