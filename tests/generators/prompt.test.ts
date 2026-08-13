import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanMessage, escapeHtml, escapeXml, extractTopic, parseDeck, parseDocument, splitClauses } from "../../lib/generators/prompt";

test("1. cleanMessage 去掉引导动词/页数/格式词", () => {
  assert.equal(cleanMessage("做两页 PPT 介绍 Go AI 文件处理功能"), "Go AI 文件处理功能");
  assert.equal(cleanMessage("生成一个网页，主题：Go AI 产品"), "Go AI 产品");
  assert.equal(cleanMessage("帮我写一份 csv 表格"), "");
});

test("2. extractTopic 提取标题并截断", () => {
  assert.equal(extractTopic("做两页 PPT 介绍 Go AI 文件处理功能"), "Go AI 文件处理功能");
  assert.equal(extractTopic("生成一个很长的网页标题超过十八个字就会被截断处理"), "很长的网页标题超过十八个字就会被截断");
  assert.equal(extractTopic(""), "演示文稿");
});

test("3. splitClauses 按换行/句号/逗号切分", () => {
  assert.deepEqual(splitClauses("第一页讲背景，第二页讲方案\n第三页讲落地"), ["第一页讲背景", "第二页讲方案", "第三页讲落地"]);
  assert.deepEqual(splitClauses(""), []);
});

test("4. parseDocument 分节", () => {
  const doc = parseDocument("主题：Go AI。第一节讲功能。第二节讲优势。第三节讲路线图。第四节讲风险。第五节讲结论。第六节讲附录。第七节讲更多。");
  assert.equal(doc.title, "Go AI");
  assert.ok(doc.sections.length <= 6);
  assert.ok(doc.sections.every((s) => s.items.length <= 4));
});

test("5. parseDeck 生成标题页 + 内容页", () => {
  const deck = parseDeck("做两页 PPT 介绍 Go AI 文件处理功能");
  assert.equal(deck.title, "Go AI 文件处理功能");
  assert.equal(deck.subtitle, "由 Go AI 生成");
  assert.ok(deck.slides.length >= 1 && deck.slides.length <= 5);
  const deck2 = parseDeck("完全没有内容的输入");
  assert.ok(deck2.slides.length >= 1);
});

test("6. 转义函数", () => {
  assert.equal(escapeHtml('<script>"x" & \'y\'</script>'), "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;");
  assert.equal(escapeXml("<a> & \"b\" 'c'</a>"), "&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;&lt;/a&gt;");
});
