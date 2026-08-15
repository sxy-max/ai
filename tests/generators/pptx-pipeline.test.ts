/** WP6 测试：PresentationSpec → pptxgenjs 渲染 → 真实 .pptx 可解析（物理题两页）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { specFromText, type PresentationSpec } from "../../lib/generators/presentationSpec";
import { renderPptxFromSpec } from "../../lib/generators/pptxRenderer";

/** 验收输入：旋转圆环小珠问题两页 PPT。 */
const PHYSICS_SPEC: PresentationSpec = {
  title: "旋转圆环上的小珠：平衡与稳定性",
  subtitle: "经典力学问题分析",
  slides: [
    {
      title: "问题背景与拉格朗日量",
      sections: [
        "质量为 m 的小珠在半径为 R 的竖直圆环上无摩擦滑动，圆环绕竖直直径以角速度 ω 匀速旋转。",
        "参数：m（小珠质量）、R（圆环半径）、ω（转动角速度）、g（重力加速度）、θ（小珠与竖直方向夹角）。",
        "广义坐标取 θ，系统具有绕竖直轴的旋转对称性，动能含旋转项。"
      ],
      equations: ["L = \\frac{1}{2}mR^2\\dot{\\theta}^2 + \\frac{1}{2}mR^2\\omega^2\\sin^2\\theta - mgR\\cos\\theta"],
      notes: "拉格朗日量由平动动能、旋转动能与重力势能构成。"
    },
    {
      title: "平衡位置、稳定性与小振动频率",
      sections: [
        "平衡条件由有效势 V_eff = -\\frac{1}{2}mR^2\\omega^2\\sin^2\\theta + mgR\\cos\\theta 的极值给出。",
        "θ=0（底部）恒为平衡点；当 ω² > g/R 时出现非平凡平衡点。",
        "小振动频率由有效势二阶导数在平衡点取值给出。"
      ],
      equations: [
        "\\Omega = \\sqrt{\\omega^2 - \\frac{g^2}{R^2\\omega^2}}",
        "\\theta_0 = \\arccos\\left(\\frac{g}{R\\omega^2}\\right)"
      ],
      notes: "底部平衡在 ω² < g/R 时稳定，ω² > g/R 后失稳。"
    }
  ]
};

test("spec → renderPptx → 两页真实 .pptx（标题/内容/公式可解析）", async () => {
  const buffer = await renderPptxFromSpec(PHYSICS_SPEC);
  assert.ok(buffer.length > 10000, "pptx 应有实际体积");
  // OOXML 魔数 PK
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);

  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideFiles.length, 2, "两页内容页（V1.4 起无封面页）");

  // 内容页文本包含物理内容
  const slide1 = await zip.file("ppt/slides/slide1.xml")?.async("string");
  assert.match(slide1 || "", /问题背景/);
  assert.match(slide1 || "", /拉格朗日量/);
  const slide2 = await zip.file("ppt/slides/slide2.xml")?.async("string");
  assert.match(slide2 || "", /平衡位置/);
  assert.match(slide2 || "", /小振动频率/);
});

test("specFromText：markdown 提纲回退 → 结构化 spec", () => {
  const spec = specFromText("# 销售分析\n## 一季度\n- 总销售额 3.68 万\n## 趋势\n- 2 月为峰值");
  assert.equal(spec.title, "销售分析");
  assert.ok(spec.slides.length >= 1);
  assert.ok(spec.slides[0].sections.length >= 1);
});

test("renderPptx：空 spec 防御（无 slides 时仍产出标题页）", async () => {
  const buffer = await renderPptxFromSpec({ title: "空演示", slides: [] });
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, 1, "至少标题页");
});
