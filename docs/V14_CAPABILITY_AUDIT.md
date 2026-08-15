# V14 Capability Audit（2026-08-15，V1.4 WP1）

实际运行验证（真实文件生成 + V1.2/V1.3 云端 E2E 数据），非代码阅读。

## 能力矩阵

| # | 能力 | 状态 | 证据 |
|---|------|------|------|
| 1 | Markdown → artifact | ✅ real | 生成器 41B；云端 E2 note v1/v3（agent 真实产出） |
| 2 | TXT → artifact | ✅ real | agent workspace 路径（同 markdown） |
| 3 | HTML → artifact | ✅ real | 生成器 1439B；云端 E6 index v1 |
| 4 | CSV → artifact | ✅ real | 生成器 10B；云端 E3 去重排序内容验证 |
| 5 | XLSX → artifact | ✅ real | 生成器 15950B ZIP-OK；xlsx reader（输入结构摘要） |
| 6 | PPTX → artifact | ✅ real | renderer 52373B ZIP-OK；云端 E4 60KB 合法容器；theme 支持 |
| 7 | DOCX → artifact | ✅ real | 生成器 8639B ZIP-OK（heading/list/table 基础） |
| 8 | PDF → artifact | ❌ **missing** | 生成器不支持；PDF 输入仅二进制提示 |
| 9 | PNG/JPG → vision | ✅ real | MiniMax describe 实测（文字/布局/颜色读出） |
| 10 | ZIP → workspace | ✅ real | safeExtractZip + E7 重打包 + 3 文件清单 |
| 11 | URL → fetch | ⚠️ partial | 聊天路径 url_fetch 工具；**任务内无**（Agent 无网页访问） |
| 12 | Browser | ❌ **missing** | 无 browser runtime（V1.4 WP19 P0） |
| 13 | Screenshot | ⚠️ partial | render-html.mjs 产物截图（验证用）；**非 Agent 能力** |
| 14 | image edit | ❌ **missing** | 无图像编辑工具 |
| 15 | code execution | ✅ real | sandbox code.node.exec + shell.exec |
| 16 | preview | ❌ **missing** | 无预览系统（artifact 只有下载） |
| 17 | artifact continuation | ✅ real | continue v2 版本化 + lineage（parent_artifact_id） |
| 18 | project continuation | ⚠️ partial | project 上下文 + 产物摘要；ENABLE_PROJECT_WS 默认关（adapter 映射待配套） |

## V1.4 必须补齐（按优先级）

1. **PDF 生成/读取**（WP12）——当前完全缺失
2. **Browser Runtime**（WP19-24，P0）——Agent 无网页能力
3. **Preview System**（WP17-18）——用户无法不下载判断结果
4. **任务内 URL/网页工具**（WP19）——URL fetch 只在聊天
5. **Screenshot→Web 闭环**（WP23-24）——当前只有产物侧截图
6. **image edit**（WP23/24 附带）——图像处理工具
7. **Project Workspace 全开**（WP37）——adapter 映射配套

## 结论

文件类交付（MD/HTML/CSV/XLSX/PPTX/DOCX/ZIP）已 real；
**PDF/浏览器/预览/项目全开** 是 V1.4 的真实缺口。
所有状态基于物理文件验证（ZIP 容器检查 + 内容断言），无 Markdown 冒充。
