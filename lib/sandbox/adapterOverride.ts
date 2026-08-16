/**
 * Adapter 覆盖注入点（测试基础设施；生产永远为 null）。
 * 任务级测试（tests/tasks.test.ts 等）在本地无 file-agent 容器时注入
 * FakeClaudeCodeAdapter，验证「directive → devExecutor → 产物注册 → 完成」完整链路；
 * 生产路径不受影响（getAdapterOverride() 恒为 null）。
 */

import type { AgentRuntimeAdapter } from "./adapter";

let override: AgentRuntimeAdapter | null = null;

export function setAdapterOverride(adapter: AgentRuntimeAdapter | null): void {
  override = adapter;
}

export function getAdapterOverride(): AgentRuntimeAdapter | null {
  return override;
}
