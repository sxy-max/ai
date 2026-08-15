/**
 * PPTX Renderer（WP6）：PresentationSpec → 真实 .pptx（pptxgenjs）。
 * 内容与渲染完全分离：spec 由 LLM/启发式产出，本模块只负责排版。
 */

import PptxGenJS from "pptxgenjs";
import type { PresentationSpec } from "./presentationSpec";

const FONT = "Microsoft YaHei";
const ACCENT = "2563EB";

/** 默认主题（spec.theme 可覆盖；WP15 主题结构化）。 */
export type RenderTheme = {
  titleBackground: string;
  titleText: string;
  subtitleText: string;
  footerText: string;
  slideBackground: string;
  headingText: string;
  accent: string;
  bodyText: string;
};

const DEFAULT_THEME: RenderTheme = {
  titleBackground: "0F172A",
  titleText: "FFFFFF",
  subtitleText: "94A3B8",
  footerText: "64748B",
  slideBackground: "FFFFFF",
  headingText: "0F172A",
  accent: ACCENT,
  bodyText: "1E293B",
};

function themeOf(spec: PresentationSpec): RenderTheme {
  const t = spec.theme || {};
  return {
    ...DEFAULT_THEME,
    ...(t.titleBackground ? { titleBackground: t.titleBackground } : {}),
    ...(t.titleText ? { titleText: t.titleText } : {}),
    ...(t.subtitleText ? { subtitleText: t.subtitleText } : {}),
    ...(t.slideBackground ? { slideBackground: t.slideBackground } : {}),
    ...(t.headingText ? { headingText: t.headingText } : {}),
    ...(t.accent ? { accent: t.accent } : {}),
    ...(t.bodyText ? { bodyText: t.bodyText } : {}),
  };
}

/** 渲染 spec 为 .pptx buffer。 */
export async function renderPptxFromSpec(spec: PresentationSpec): Promise<Buffer> {
  const theme = themeOf(spec);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.author = "Go AI";
  pptx.company = "Cloud Agent Workspace";
  pptx.title = spec.title;

  // 标题页
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: theme.titleBackground };
  titleSlide.addText(spec.title, {
    x: 0.8, y: 2.2, w: 11.7, h: 1.6,
    fontSize: 34, bold: true, color: theme.titleText, fontFace: FONT,
    align: "center", valign: "middle"
  });
  if (spec.subtitle) {
    titleSlide.addText(spec.subtitle, {
      x: 0.8, y: 4.0, w: 11.7, h: 0.6,
      fontSize: 16, color: theme.subtitleText, fontFace: FONT, align: "center"
    });
  }
  titleSlide.addText("由 Go AI 云端智能体工作台生成", {
    x: 0.8, y: 6.6, w: 11.7, h: 0.4,
    fontSize: 10, color: theme.footerText, fontFace: FONT, align: "center"
  });

  // 内容页
  for (const slide of spec.slides) {
    const s = pptx.addSlide();
    s.background = { color: theme.slideBackground };
    s.addText(slide.title, {
      x: 0.6, y: 0.35, w: 12.1, h: 0.9,
      fontSize: 26, bold: true, color: theme.headingText, fontFace: FONT
    });
    s.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.25, w: 12.1, h: 0.06, fill: { color: theme.accent } });

    let y = 1.55;
    const sections = slide.sections.slice(0, 6);
    const equations = slide.equations.slice(0, 3);

    if (slide.layout === "two-column" && sections.length >= 2) {
      const left = sections.slice(0, Math.ceil(sections.length / 2));
      const right = sections.slice(Math.ceil(sections.length / 2));
      s.addText(left.map((t) => ({ text: t, options: { bullet: true } })), {
        x: 0.7, y, w: 5.8, h: 4.8, fontSize: 14, color: theme.bodyText, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.3
      });
      s.addText(right.map((t) => ({ text: t, options: { bullet: true } })), {
        x: 6.9, y, w: 5.8, h: 4.8, fontSize: 14, color: theme.bodyText, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.3
      });
    } else {
      s.addText(sections.map((t) => ({ text: t, options: { bullet: true } })), {
        x: 0.7, y, w: 11.9, h: equations.length ? 3.6 : 5.4,
        fontSize: 15, color: theme.bodyText, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.35
      });
    }

    if (equations.length) {
      const eqY = slide.layout === "two-column" ? 6.3 : Math.min(y + 3.9, 5.9);
      s.addText(equations.map((eq, i) => ({ text: `${i + 1}. ${eq}`, options: {} })), {
        x: 0.7, y: eqY, w: 11.9, h: 1.1,
        fontSize: 13, italic: true, color: theme.accent, fontFace: "Consolas", valign: "middle"
      });
    }
  }

  const buffer = await pptx.write({ outputType: "nodebuffer" });
  if (Buffer.isBuffer(buffer)) return buffer;
  if (buffer instanceof ArrayBuffer) return Buffer.from(new Uint8Array(buffer));
  return Buffer.from(String(buffer), "utf8");
}
