import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { generatePptx } from "../../lib/generators/pptx";

async function loadSlides(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const slides: string[] = [];
  for (const name of names.sort((a, b) => parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0]))) {
    slides.push(await zip.file(name)!.async("string"));
  }
  return slides;
}

test("1. 生成合法 PPTX 包：zip 结构 + 必要部件齐备", async () => {
  const out = await generatePptx({ message: "做两页 PPT 介绍 Go AI 文件处理功能" });
  assert.equal(out.kind, "pptx");
  assert.equal(out.mime, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.match(out.filename, /\.pptx$/);
  assert.ok(out.content.length > 1000, "pptx 过小");

  const zip = await JSZip.loadAsync(out.content);
  for (const required of ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/slideLayouts/slideLayout1.xml", "ppt/theme/theme1.xml", "ppt/slides/slide1.xml"]) {
    assert.ok(zip.file(required), `缺少部件 ${required}`);
  }
  const slides = await loadSlides(out.content);
  assert.ok(slides.length >= 2, "至少标题页 + 内容页");
});

test("2. 标题页含标题文本；内容页含要点（XML 转义）", async () => {
  const out = await generatePptx({ message: "做两页 PPT，主题：Go AI & 云 <安全> 演示" });
  const slides = await loadSlides(out.content);
  const slide1 = slides[0];
  assert.ok(slide1.includes("&lt;安全&gt;"), "特殊字符必须转义");
  assert.ok(slide1.includes("&amp;"), "& 必须转义");
  const slide2 = slides[1];
  assert.ok(slide2.includes("<a:t>"), "内容页含文本段");
});

test("3. 页数上限 6，确定性：同输入同输出", async () => {
  const longMsg = Array.from({ length: 20 }, (_, i) => `第${i + 1}条内容`).join("，");
  const a = await generatePptx({ message: longMsg });
  const b = await generatePptx({ message: longMsg });
  const slidesA = await loadSlides(a.content);
  assert.ok(slidesA.length <= 6, "总页数（含标题页）应 ≤ 6");
  assert.deepEqual(a.content, b.content, "同输入应产生相同字节");
});
