/**
 * Presentation Spec（WP6）：PPTX 的内容与渲染分离。
 * LLM 产出结构化 PresentationSpec（标题/幻灯片/小节/公式/备注/布局），
 * pptxRenderer 负责渲染；LLM 不可用时由文本启发式回退（parseDeck 结构）。
 */

import { completeChat, extractJson } from "../llm/complete";
import { parseDeck } from "./prompt";

export type PresentationSlide = {
  title: string;
  /** 内容小节（段落/要点）。 */
  sections: string[];
  /** 公式（文本形式，如 LaTeX 源码或 Unicode）。 */
  equations: string[];
  /** 演讲者备注。 */
  notes?: string;
  /** V1.4 WP5：布局原语（Layout Engine；content=自动启发式）。 */
  layout?: "title" | "title-content" | "two-column" | "comparison" | "timeline" | "process" | "data" | "image-focus" | "quote" | "summary" | "content";
};

export type PresentationSpec = {
  title: string;
  subtitle?: string;
  slides: PresentationSlide[];
  /** V1.2 WP15：主题（可选；缺省由 renderer 默认主题）。 */
  theme?: {
    titleBackground?: string;
    titleText?: string;
    subtitleText?: string;
    slideBackground?: string;
    headingText?: string;
    accent?: string;
    bodyText?: string;
  };
};

const SPEC_SYSTEM = `你是云端 AI 工作系统的演示文稿规划器。根据用户要求生成结构化演示文稿内容。
输出严格为 JSON（不要任何其他文字）：
{
  "title": "演示标题",
  "subtitle": "副标题（可选）",
  "slides": [
    {
      "title": "页标题",
      "sections": ["要点或段落 1", "要点或段落 2"],
      "equations": ["公式（LaTeX 源码文本，如 \\\\omega = \\\\sqrt{\\\\frac{g}{R}}；没有则为空数组）"],
      "notes": "演讲者备注（可选）",
      "layout": "content"
    }
  ]
}
规则：内容基于用户要求与材料事实；材料没有的明确写"（材料未提供）"，不编造；公式用 LaTeX 源码文本形式。`;

/** 由 LLM 生成结构化演示文稿 spec；未配置 LLM 或解析失败返回 null。 */export async function specFromLlm(goal: string, fileContext: string): Promise<PresentationSpec | null> {
  const raw = await completeChat({
    messages: [
      { role: "system", content: SPEC_SYSTEM },
      { role: "user", content: `任务要求：${goal}\n\n${fileContext || "（无参考材料）"}` }
    ],
    jsonMode: true,
    maxTokens: 8192,
    temperature: 0.4,
    timeoutMs: 240_000
  });
  if (!raw) return null;
  const parsed = extractJson<unknown>(raw);
  if (!isSpec(parsed)) return null;
  return normalizeSpec(parsed);
}

/** 文本启发式回退：markdown 提纲（# 标题 / ## 页 / - 要点）→ spec。 */
export function specFromText(message: string): PresentationSpec {
  const deck = parseDeck(message);
  return {
    title: deck.title,
    subtitle: deck.subtitle,
    slides: deck.slides.map((slide) => ({
      title: slide.title,
      sections: slide.bullets,
      equations: [],
      layout: "content" as const
    }))
  };
}

function isSpec(value: unknown): value is PresentationSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Record<string, unknown>;
  if (typeof spec.title !== "string" || !spec.title.trim()) return false;
  if (!Array.isArray(spec.slides) || spec.slides.length === 0) return false;
  return spec.slides.every((slide) => {
    const s = slide as Record<string, unknown>;
    return s && typeof s === "object" && typeof s.title === "string" && Array.isArray(s.sections);
  });
}

/** V1.4 WP5：全部布局原语。 */
const VALID_LAYOUTS = ["title", "title-content", "two-column", "comparison", "timeline", "process", "data", "image-focus", "quote", "summary", "content"];

function normalizeSpec(value: PresentationSpec): PresentationSpec {
  const hexOf = (v: unknown): string | undefined => {
    const s = String(v || "").trim();
    return /^[0-9a-fA-F]{3,8}$/.test(s) ? s.toUpperCase() : undefined;
  };
  const theme = value.theme && typeof value.theme === "object" ? value.theme : undefined;
  return {
    title: String(value.title).slice(0, 120),
    subtitle: typeof value.subtitle === "string" ? value.subtitle.slice(0, 200) : undefined,
    slides: value.slides.slice(0, 12).map((slide, index) => ({
      title: String(slide.title || `第 ${index + 1} 页`).slice(0, 120),
      sections: (Array.isArray(slide.sections) ? slide.sections : []).map((s) => String(s).slice(0, 500)).slice(0, 8),
      equations: (Array.isArray(slide.equations) ? slide.equations : []).map((e) => String(e).slice(0, 300)).slice(0, 4),
      notes: typeof slide.notes === "string" ? slide.notes.slice(0, 500) : undefined,
      layout: VALID_LAYOUTS.includes(slide.layout as string) ? slide.layout : "content"
    })),
    ...(theme
      ? {
          theme: {
            ...(hexOf(theme.titleBackground) ? { titleBackground: hexOf(theme.titleBackground) } : {}),
            ...(hexOf(theme.titleText) ? { titleText: hexOf(theme.titleText) } : {}),
            ...(hexOf(theme.subtitleText) ? { subtitleText: hexOf(theme.subtitleText) } : {}),
            ...(hexOf(theme.slideBackground) ? { slideBackground: hexOf(theme.slideBackground) } : {}),
            ...(hexOf(theme.headingText) ? { headingText: hexOf(theme.headingText) } : {}),
            ...(hexOf(theme.accent) ? { accent: hexOf(theme.accent) } : {}),
            ...(hexOf(theme.bodyText) ? { bodyText: hexOf(theme.bodyText) } : {}),
          },
        }
      : {}),
  };
}

/** MCP 工具箱：把外部 JSON spec 归一化为 PresentationSpec（office-mcp 调用）。
 *  允许 {title, slides:[{title, sections:[{heading?, bullets?}|string], equations?, notes?}]}
 *  兼容字符串小节与对象小节两种写法。 */
export function specFromJson(raw: unknown): PresentationSpec {
  const input = (raw || {}) as Record<string, unknown>;
  const slidesRaw = Array.isArray(input.slides) ? input.slides : [];
  const slides = slidesRaw.map((s) => {
    const slide = (s || {}) as Record<string, unknown>;
    const sectionsRaw = Array.isArray(slide.sections) ? slide.sections : [];
    const sections = sectionsRaw.map((sec) => {
      if (typeof sec === "string") return sec;
      const obj = sec as Record<string, unknown>;
      if (Array.isArray(obj.bullets)) return `${obj.heading ? `${obj.heading}：` : ""}${obj.bullets.join("；")}`;
      return String(obj.heading || "");
    });
    return {
      title: String(slide.title || ""),
      sections,
      equations: Array.isArray(slide.equations) ? slide.equations.map(String) : [],
      ...(slide.notes ? { notes: String(slide.notes) } : {}),
      ...(typeof slide.layout === "string" ? { layout: slide.layout } : {}),
    };
  });
  const spec: PresentationSpec = {
    title: String(input.title || (slides[0]?.title || "演示文稿")),
    slides: slides.length ? slides : [{ title: "演示文稿", sections: [] }],
  };
  if (input.subtitle) spec.subtitle = String(input.subtitle);
  if (input.theme && typeof input.theme === "object") spec.theme = input.theme as PresentationSpec["theme"];
  return spec;
}
