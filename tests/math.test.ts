import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMathDelimiters } from "../lib/math";

test("converts LaTeX inline and block delimiters to dollar form", () => {
  assert.equal(normalizeMathDelimiters("质量为 \\(m\\) 的球"), "质量为 $m$ 的球");
  assert.equal(normalizeMathDelimiters("\\[ x = 1 \\]"), "$$ x = 1 $$");
  assert.equal(normalizeMathDelimiters("角速度 \\(\\omega\\)，块级 \\[ \\Omega=\\sqrt{1} \\]"), "角速度 $\\omega$，块级 $$ \\Omega=\\sqrt{1} $$");
});

test("handles nested parens and multi-line block math", () => {
  assert.equal(normalizeMathDelimiters("\\[ \\begin{cases} a \\\\ b \\end{cases} \\]"), "$$ \\begin{cases} a \\\\ b \\end{cases} $$");
  assert.equal(normalizeMathDelimiters("\\(f(x) = x^2\\)"), "$f(x) = x^2$");
});

test("leaves code fences and inline code untouched", () => {
  const fenced = "```js\nconst m = \\(not math\\);\n```\n外面 \\(m\\)";
  assert.equal(normalizeMathDelimiters(fenced), "```js\nconst m = \\(not math\\);\n```\n外面 $m$");
  assert.equal(normalizeMathDelimiters("`\\(x\\)` 保持 \\(y\\)"), "`\\(x\\)` 保持 $y$");
});

test("leaves text without latex delimiters unchanged", () => {
  assert.equal(normalizeMathDelimiters("普通文本 $x$ 和 $$y$$"), "普通文本 $x$ 和 $$y$$");
  assert.equal(normalizeMathDelimiters(""), "");
});

test("unbalanced opener is left as-is", () => {
  assert.equal(normalizeMathDelimiters("未闭合 \\(m"), "未闭合 \\(m");
});
