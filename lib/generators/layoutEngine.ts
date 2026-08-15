/**
 * PPT Layout Engine（V1.4 WP5）：确定性布局原语。
 * LLM 选择 layout 和内容；本引擎负责物理排布（safeArea/网格/间距/字号/密度）。
 * 目标：文字不超界、标题不撞正文、项目符号不爆满、图表不裁、公式不重叠。
 */

export type LayoutType =
  | "title" | "title-content" | "two-column" | "comparison"
  | "timeline" | "process" | "data" | "image-focus" | "quote" | "summary";

export type LayoutBlock = {
  kind: "title" | "body" | "equation" | "image" | "chart" | "quote" | "stat";
  x: number; y: number; w: number; h: number;
  fontScale: number;
};

export type SlideContent = {
  title: string;
  sections: string[];
  equations?: string[];
  imageHint?: boolean;
  chartHint?: boolean;
  quote?: string;
  stats?: Array<{ label: string; value: string }>;
};

/** 幻灯片可用区（13.33x7.5 英寸画布，页边距 0.6）。 */
export const SAFE_AREA = { x: 0.6, y: 0.6, w: 12.13, h: 6.3 };

const FONT_SIZES = {
  title: 26, body: 14, equation: 13, quote: 20, stat: 24, statLabel: 12,
};

/** 文字密度估计（中文 1 字 ≈ 1 单位；英文 1 词 ≈ 1.2 单位）。 */
export function estimateTextUnits(text: string): number {
  const cjk = (text.match(/[一-鿿　-〿]/g) || []).length;
  const words = text.replace(/[一-鿿　-〿]/g, " ").split(/\s+/).filter(Boolean).length;
  return cjk + words * 1.2;
}

export type LayoutResult = {
  blocks: LayoutBlock[];
  /** 密度检查：0-1（>1 溢出）。 */
  density: number;
  issues: string[];
};

/**
 * 计算布局。deterministic：同一内容 → 同一布局。
 * 防溢出：按内容量自动调节字号（fontScale 0.8-1.15），超出容量则标记 issue。
 */
export function computeLayout(layout: LayoutType, content: SlideContent): LayoutResult {
  const blocks: LayoutBlock[] = [];
  const issues: string[] = [];
  const { x, y, w, h } = SAFE_AREA;

  // 标题区（所有布局）
  const titleH = 0.8;
  blocks.push({ kind: "title", x, y, w, h: titleH, fontScale: 1 });
  const bodyTop = y + titleH + 0.25;

  // 正文内容（sections）
  const bodyText = content.sections.join("\n");
  const bodyUnits = estimateTextUnits(bodyText);
  const eqUnits = (content.equations || []).reduce((s, e) => s + estimateTextUnits(e), 0);

  switch (layout) {
    case "title": {
      blocks.push({ kind: "body", x: x + 0.5, y: bodyTop + 1.2, w: w - 1, h: 2.6, fontScale: 1.4 });
      break;
    }
    case "title-content": {
      const bodyH = h - (bodyTop - y) - (content.equations?.length ? 1.4 : 0);
      blocks.push({ kind: "body", x, y: bodyTop, w, h: bodyH, fontScale: 1 });
      if (content.equations?.length) {
        blocks.push({ kind: "equation", x, y: bodyTop + bodyH + 0.1, w, h: 1.2, fontScale: 1 });
      }
      break;
    }
    case "two-column": {
      const colW = (w - 0.3) / 2;
      const half = Math.ceil(content.sections.length / 2);
      blocks.push({ kind: "body", x, y: bodyTop, w: colW, h: h - (bodyTop - y), fontScale: 1 });
      blocks.push({ kind: "body", x: x + colW + 0.3, y: bodyTop, w: colW, h: h - (bodyTop - y), fontScale: 1 });
      void half;
      break;
    }
    case "comparison": {
      const colW = (w - 0.3) / 2;
      blocks.push({ kind: "body", x, y: bodyTop, w: colW, h: h - (bodyTop - y), fontScale: 1 });
      blocks.push({ kind: "body", x: x + colW + 0.3, y: bodyTop, w: colW, h: h - (bodyTop - y), fontScale: 1 });
      break;
    }
    case "timeline":
    case "process": {
      const steps = Math.max(content.sections.length, 1);
      const stepH = Math.min(1.0, (h - (bodyTop - y) - 0.4) / Math.min(steps, 6));
      for (let i = 0; i < Math.min(steps, 6); i++) {
        blocks.push({ kind: "body", x, y: bodyTop + i * (stepH + 0.12), w, h: stepH, fontScale: 1 });
      }
      break;
    }
    case "data": {
      const bodyH = content.chartHint ? (h - (bodyTop - y)) * 0.45 : h - (bodyTop - y);
      blocks.push({ kind: "body", x, y: bodyTop, w, h: bodyH, fontScale: 1 });
      if (content.chartHint) {
        blocks.push({ kind: "chart", x, y: bodyTop + bodyH + 0.15, w, h: h - (bodyTop - y) - bodyH - 0.15, fontScale: 1 });
      }
      break;
    }
    case "image-focus": {
      const imgW = w * 0.5;
      blocks.push({ kind: "body", x, y: bodyTop, w: w - imgW - 0.3, h: h - (bodyTop - y), fontScale: 1 });
      if (content.imageHint) {
        blocks.push({ kind: "image", x: x + w - imgW, y: bodyTop, w: imgW, h: h - (bodyTop - y), fontScale: 1 });
      }
      break;
    }
    case "quote": {
      blocks.push({ kind: "quote", x: x + 0.5, y: bodyTop + 0.8, w: w - 1, h: 2.2, fontScale: 1.2 });
      blocks.push({ kind: "body", x, y: bodyTop + 3.2, w, h: h - (bodyTop - y) - 3.2, fontScale: 0.9 });
      break;
    }
    case "summary": {
      blocks.push({ kind: "body", x: x + 0.3, y: bodyTop, w: w - 0.6, h: h - (bodyTop - y), fontScale: 1.1 });
      if (content.stats?.length) {
        const per = (w - 0.6) / content.stats.length;
        content.stats.forEach((_, i) => {
          blocks.push({ kind: "stat", x: x + 0.3 + i * per, y: h - 1.3, w: per - 0.2, h: 1.0, fontScale: 1 });
        });
      }
      break;
    }
  }

  // 密度检查：正文容量 vs 区块面积（估算）
  const bodyArea = blocks.filter((b) => b.kind === "body").reduce((s, b) => s + b.w * b.h * 2.2, 0);
  const totalUnits = bodyUnits + eqUnits * 1.5;
  const density = bodyArea > 0 ? totalUnits / bodyArea : 1;
  if (density > 1.6) issues.push("TEXT_OVERFLOW：内容密度过高，建议压缩文字");
  if (density > 2.2) issues.push("TEXT_SEVERE_OVERFLOW：需要拆分内容或缩短文字");
  if (content.sections.length > 7) issues.push("BULLET_OVERFLOW：项目符号超过 7 条");
  if (content.title.length > 40) issues.push("TITLE_TOO_LONG：标题超过 40 字");

  // 字号微调（fontScale 1.15 上限；防溢出时下调）
  for (const block of blocks) {
    if (block.kind === "body" && density > 1.3) block.fontScale = 0.9;
    if (block.kind === "body" && density > 1.8) block.fontScale = 0.8;
  }

  return { blocks, density, issues };
}

export function layoutOptions(): LayoutType[] {
  return ["title", "title-content", "two-column", "comparison", "timeline", "process", "data", "image-focus", "quote", "summary"];
}

/** 内容 → 推荐布局（deterministic 启发式；LLM 可覆盖）。 */
export function suggestLayout(content: SlideContent): LayoutType {
  if (content.quote) return "quote";
  if (content.chartHint || content.stats?.length) return "data";
  if (content.imageHint) return "image-focus";
  if (content.sections.length >= 6) return "two-column";
  if (content.equations?.length) return "title-content";
  if (content.sections.length >= 4) return "timeline";
  return "title-content";
}

export { FONT_SIZES };
