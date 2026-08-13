# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: message-lifecycle.spec.ts >> TEST3 连续第二轮
- Location: tests\e2e\message-lifecycle.spec.ts:40:5

# Error details

```
Test timeout of 90000ms exceeded.
```

# Page snapshot

```yaml
- main [ref=f1e2]:
  - complementary [ref=f1e3]:
    - strong [ref=f1e5]: Go AI
    - button "＋ 新对话" [ref=f1e6] [cursor=pointer]
  - generic [ref=f1e8]:
    - generic [ref=f1e9]:
      - button "☰" [ref=f1e10] [cursor=pointer]
      - generic [ref=f1e11]:
        - generic [ref=f1e12]: MODEL
        - combobox [ref=f1e13]:
          - option "选择最强模型…" [selected]
      - button "＋" [ref=f1e14] [cursor=pointer]
    - generic [ref=f1e18]:
      - generic [ref=f1e19]: AI
      - heading "只把最强模型放在入口。" [level=2] [ref=f1e20]
      - paragraph [ref=f1e21]: OpenCode Go 始终可独立使用；配置 Anthropic Key 后会自动加入 Claude。联网、URL 和文件内容都只经服务端授权接口处理。
    - generic [ref=f1e22]: E2E-MOCK
    - generic [ref=f1e23]:
      - generic [ref=f1e24]:
        - button "◎ 自动联网" [ref=f1e25] [cursor=pointer]
        - button "⚙ 参数" [ref=f1e26] [cursor=pointer]
        - generic [ref=f1e27]: 未选择模型
      - generic [ref=f1e28]:
        - generic "最多 4 个 JPEG/PNG/GIF/WebP、PDF、文本或代码文件" [ref=f1e29] [cursor=pointer]: ＋
        - textbox "问点什么，或粘贴 URL…" [ref=f1e30]
        - button "↑" [ref=f1e31] [cursor=pointer]
      - generic [ref=f1e32]: 历史正文保存在本机 · 附件内容不落盘，刷新后需重新添加 · API Key 只在服务端 · URL/联网使用 Exa MCP
```