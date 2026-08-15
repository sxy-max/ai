/**
 * VisionVerifier（V1.2 WP12）：视觉保真度验证。
 * 输入：参考图的 VisionContext（MiniMax 结构化描述）vs 产物截图的 VisionContext。
 * 结构化比较：visible_text 重叠、colors 主色、ui_elements 数量、layout 结构。
 * 输出：score(0-1) + feedback + missing（差距项）。用于"按图改页面"的视觉闭环
 * （一次 repair，不无限）。
 */

import type { StructuredVisualDescription } from "../vision";

export type VisionVerificationResult = {
  score: number;
  pass: boolean;
  threshold: number;
  feedback: string[];
  missing: string[];
};

const STOP_WORDS = new Set(["无", "没有", "none", "n/a", "unknown", "不确定", "无法确认"]);

function meaningful(text: string | undefined): string {
  const t = String(text || "").trim();
  return STOP_WORDS.has(t.toLowerCase()) ? "" : t;
}

/** 提取可见文本 token（按标点/空白切分，去停用词）。 */
function textTokens(text: string | undefined): Set<string> {
  const t = meaningful(text);
  if (!t) return new Set();
  const tokens = t
    .split(/[\s，。；、,.!?！？:：;；"'（）()\-—/\\]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !/^\d+$/.test(x));
  return new Set(tokens);
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit++;
  return hit / Math.min(a.size, b.size);
}

/** 颜色关键词集合（描述中出现的色名）。 */
function colorTokens(text: string | undefined): Set<string> {
  const t = meaningful(text);
  if (!t) return new Set();
  const names = t.match(/(深|浅|亮|暗)?(蓝|绿|红|黄|紫|橙|白|黑|灰|青|粉|棕|金|银)(色|背景|按钮|文字)?/g) || [];
  const hex = t.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  return new Set([...names.map((n) => n.toLowerCase()), ...hex.map((h) => h.toLowerCase())]);
}

function colorOverlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const c of a) if (b.has(c)) hit++;
  return hit / Math.min(a.size, b.size);
}

/** 数量类字段的接近度（ui_elements / objects / blocks）：统计所有计数之和。 */
function countNearness(a: string | undefined, b: string | undefined): number | null {
  const countOf = (s: string | undefined): number | null => {
    const matches = String(s || "").matchAll(/(\d+)\s*(个|块|张|项|条|处|元素|卡片|按钮|瓷片)/g);
    let total = 0;
    let found = false;
    for (const m of matches) {
      total += Number(m[1]);
      found = true;
    }
    return found ? total : null;
  };
  const ca = countOf(a);
  const cb = countOf(b);
  if (ca == null || cb == null) return null;
  return ca === 0 && cb === 0 ? 1 : 1 - Math.min(Math.abs(ca - cb), ca + cb) / Math.max(ca + cb, 1);
}

/**
 * 结构化比较两个 VisionContext。
 * 加权：visible_text 0.4、colors 0.3、ui_elements 数量 0.2、layout 存在性 0.1。
 * score >= threshold 判定 pass（默认 0.55——视觉描述本身有噪声，允许语义一致）。
 */
export function compareVisionContexts(
  reference: StructuredVisualDescription,
  result: StructuredVisualDescription,
  threshold = 0.55
): VisionVerificationResult {
  const refText = textTokens(reference.visible_text || reference.summary);
  const resText = textTokens(result.visible_text || result.summary);
  const textScore = tokenOverlap(refText, resText);

  const refColors = colorTokens(reference.colors || reference.summary);
  const resColors = colorTokens(result.colors || result.summary);
  const colorScore = colorOverlap(refColors, resColors);

  const elementScore = countNearness(reference.ui_elements, result.ui_elements);
  const layoutScore = meaningful(reference.layout) && meaningful(result.layout) ? 1 : 0;

  const weights = { text: 0.4, colors: 0.3, elements: 0.2, layout: 0.1 };
  const components = [
    { key: "text", value: textScore, weight: weights.text },
    { key: "colors", value: colorScore, weight: weights.colors },
    { key: "elements", value: elementScore ?? 0, weight: weights.elements },
    { key: "layout", value: layoutScore, weight: weights.layout },
  ];
  const score = components.reduce((sum, c) => sum + c.value * c.weight, 0);

  const missing: string[] = [];
  const feedback: string[] = [];
  if (textScore < 0.5) { missing.push("visible_text"); feedback.push(`可见文字重叠不足（${(textScore * 100).toFixed(0)}%）——产物页面文字与参考图差异大`); }
  if (colorScore < 0.4) { missing.push("colors"); feedback.push(`主色重叠不足（${(colorScore * 100).toFixed(0)}%）——配色偏离参考`); }
  if (elementScore != null && elementScore < 0.6) { missing.push("ui_elements"); feedback.push(`元素数量接近度低（${(elementScore * 100).toFixed(0)}%）——功能区块数量与参考不一致`); }
  if (!layoutScore) { missing.push("layout"); feedback.push("布局结构描述缺失——无法确认版面一致性"); }

  return {
    score: Number(score.toFixed(3)),
    pass: score >= threshold,
    threshold,
    feedback,
    missing,
  };
}

/** 把验证结果转成 Agent 可读的修复反馈（注入 repair instruction）。 */
export function feedbackInstruction(result: VisionVerificationResult): string {
  if (result.pass) return "";
  const lines = [`视觉验证未通过（score ${result.score} < ${result.threshold}）：`, ...result.feedback];
  return lines.join("\n");
}
