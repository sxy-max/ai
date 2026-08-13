"use client";

// 个性化面板宿主：记忆 / 回复风格 / 我的 Skills。
// 实现由后续个人化任务填充；这里先承载结构。

export default function PersonalizationPanel() {
  return (
    <div className="pz-panel">
      <section className="pz-section">
        <h3>记忆</h3>
        <p className="pz-empty">按浏览器本地保存的个人记忆，将在对话时自动注入。功能开发中。</p>
      </section>
      <section className="pz-section">
        <h3>回复风格</h3>
        <p className="pz-empty">预设：简洁 / 均衡 / 详细 / 自定义。功能开发中。</p>
      </section>
      <section className="pz-section">
        <h3>我的 Skills</h3>
        <p className="pz-empty">导入 SKILL.md，按任务自动选择。功能开发中。</p>
      </section>
    </div>
  );
}
