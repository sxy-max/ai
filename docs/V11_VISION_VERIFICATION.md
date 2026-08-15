# V11 视觉验收流程（vision MCP）

2026-08-15 建立。解决 T3/T8 类任务（参考图 → HTML 产物）"产物只验证存在、不验证视觉一致"的缺口。

## 背景

T3 图片+HTML 任务当前验收方式：产物 HTML 存在 + 非空 + 格式合法（ArtifactValidator）。
但"页面是否真的按参考图重做了"没有视觉验证——这是 V1.1 停止条件之一（云端 E2E PASS）最后补上的环节。

## 工具

- 本会话 Claude Code 的 vision MCP（`mcp__vision-mcp__vision_compare` 等），本地路径
  `D:\codex\claude-vision-mcp`，4 工具已闭环验证。
- 产物截图生成：`scripts/vision-fixture.mjs`（playwright chromium，纯本地，无模型依赖）。

## 验收流程（T3 类任务）

1. **渲染产物**：把任务产物 HTML（/api/artifacts/:id 下载）渲染为截图：

   ```bash
   node scripts/vision-fixture.mjs   # 或对任意 HTML 写等价渲染脚本
   ```

2. **对比**：调用 vision MCP：

   ```
   vision_compare(
     before_path = 参考图（任务上传的 reference.png 原图）,
     after_path  = 产物 HTML 渲染截图,
     goal        = "对比两张图判断它们是否视觉一致：布局、配色、文字内容、元素数量是否相同"
   )
   ```

3. **判定**：`goal_met: true` + `confidence >= 0.7` → 视觉验收 PASS；
   反例（错误配色/布局）必须返回差异列表，`confidence` 低 → FAIL，回 repair 循环。

## 措辞经验（实测）

- goal 写"判断是否视觉一致"，不要写"是否按参考重做"——后者会被当作
  before→after 修改目标语义，两张一致图会误报"没有实际修改"（confidence 0.3）。
- 正例实测：`goal_met: true, confidence 0.92`（布局/配色/文字/元素数量一致）。
- 反例实测：正确识别背景色、标题、按钮色、卡片数量的全部差异。
- 像素级抗锯齿差异会被标记为"极细微差异"，不影响 PASS 判定。

## Fixture

`scripts/fixtures/vision/`（已提交）：
- `reference.png` 参考设计（深色卡片 + 蓝色主按钮 + 3 功能瓷片）
- `result-ok.png`   与参考一致的实现（正例，应 PASS）
- `result-bad.png`  偏离参考的实现（反例，应 FAIL）

## 局限与后续

- vision MCP 是会话工具，不能嵌入 Node 测试进程；云端定期验收由人工/本会话执行，
  E2E 保持"存在性 + 格式"断言（脚本断言不依赖视觉模型，避免 flaky）。
- 后续可把"视觉一致性"做成可选 E2E 阶段（带 --visual 开关），由本流程人工复核。
