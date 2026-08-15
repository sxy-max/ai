# V13 Runtime Benchmark（2026-08-15，V1.3 WP37）

双 runtime（AgentScope Docker / Claude Code）真实任务对比（云端，真实模型）。
方法：同一任务类型经 ExecutionPolicy 选 runtime；记录时间/产物/工具调用/验证。

## 云端实测（腾讯云，真实模型）

| 任务 | AgentScope(Docker 沙盒, pro) | AgentScope(Docker, kimi) | Claude Code |
|------|------------------------------|--------------------------|-------------|
| MD 修改 | ✅ AS-MD（note v3 产物） | ✅ | ✅ E2（note v1） |
| CSV 去重排序 | — | — | ✅ E3（内容验证） |
| PPTX | —（deterministic） | — | ✅ E4（60KB 合法容器） |
| 图片+HTML | ✅ AS-IMG-HTML（index v3 + vision） | ✅ | ✅ E6（index v1） |
| ZIP 项目 | — | — | ✅ E7（site v2 重打包） |
| continuation | — | — | ✅ E9（v2 版本化） |

沙盒模式：AgentScope DockerWorkspace（dind sandbox-daemon）——V1.3 起生产激活
（V1.2 的 dind 初始化竞态已随 sandbox-daemon 稳定解决；模型工具协议 probe 确认三模型
均产 OpenAI tool_calls）。

## 启动时间

- go-ai-sandbox:v1（node+python+git+工具）：容器启动 < 2s（镜像预置，无运行时安装）
- AgentScope server：常驻（健康检查 200）
- Claude Code file-agent：常驻容器

## 结论（RuntimePolicy 数据）

- 文件修改类：AgentScope Docker 与 Claude Code 均可交付；AgentScope 工具循环事件可观测（TOOL_CALL_START/END）
- 复杂项目（ZIP/多文件）：Claude Code 已验证（E7）；AgentScope 待 Long Horizon 验证（WP38）
- 图片+HTML：两条路径均需 vision 预处理（runtime 无关）；AgentScope 已验证
- 预算：工具循环 tool_loop 档（每 step 2048）实测生效（runtime.json budgetTier=tool_loop）
