/**
 * 数学分隔符归一化。
 *
 * remark-math 6 / micromark-extension-math 3 只识别 `$...$` / `$$...$$`，
 * 不识别用户常用的 LaTeX 行内 `\(...\)` 与块级 `\[...\]`。
 * 渲染前把 LaTeX 分隔符转成 `$` 形式；反引号代码围栏/行内代码内的内容不触碰。
 */

function findClose(s: string, open: string, close: string, openLen: number): number {
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(open, i)) {
      depth += 1;
      i += openLen;
      continue;
    }
    if (s.startsWith(close, i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i - 2;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * `\(...\)` → `$...$`，`\[...\]` → `$$...$$`。
 * 跳过 `\` 引用的代码片段（`` `...` `` 与 ``` ``` ... ``` ```），避免误改代码内容。
 */
export function normalizeMathDelimiters(text: string): string {
  if (!text) return text;
  let out = "";
  let i = 0;
  let fence = "";
  const n = text.length;

  while (i < n) {
    if (fence) {
      const idx = text.indexOf(fence, i);
      if (idx < 0) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, idx + fence.length);
      i = idx + fence.length;
      fence = "";
      continue;
    }
    const rest = text.slice(i);
    const ticks = rest.match(/^`+/);
    if (ticks) {
      fence = ticks[0];
      out += fence;
      i += fence.length;
      continue;
    }
    if (rest.startsWith("\\[")) {
      const end = findClose(rest, "\\[", "\\]", 2);
      if (end >= 0) {
        out += "$$" + rest.slice(2, end) + "$$";
        i += end + 2;
        continue;
      }
    }
    if (rest.startsWith("\\(")) {
      const end = findClose(rest, "\\(", "\\)", 2);
      if (end >= 0) {
        out += "$" + rest.slice(2, end) + "$";
        i += end + 2;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}
