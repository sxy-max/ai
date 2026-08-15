// 临时 mock LLM（V1.2 WP8 本地验收配套）：OpenAI 兼容 /chat/completions（支持 SSE 流式）
// 行为：按任务输出 Read → Write → 完成 的工具调用序列，驱动真实 AgentScope agent 的 react 循环。
// 运行：node scripts/tmp-llm-mock.mjs（端口 18020）
import http from "node:http";

const PORT = 18020;

/** 从文本中提取 agentscope-ws 绝对路径（Windows 反斜杠属于路径；回溯到盘符或空白）。 */
function extractWorkdir(text) {
  const idx = text.indexOf("agentscope-ws");
  if (idx < 0) return null;
  let start = idx;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === ":" && start >= 2 && /[A-Za-z]/.test(text[start - 2])) { start -= 2; break; }
    if (/[\s"']/.test(ch)) break; // \\ 是 Windows 路径分隔符，属于路径
    start--;
  }
  let end = idx + "agentscope-ws".length;
  while (end < text.length && !/[\s"']/.test(text[end])) end++;
  return text.slice(start, end).replace(/\\/g, "/").replace(/\/+$/, "");
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolChunk(streamId, name, argsJson) {
  return {
    choices: [{ index: 0, delta: { role: "assistant", content: "", tool_calls: [{ index: 0, id: streamId, type: "function", function: { name, arguments: argsJson } }] }, finish_reason: null }],
  };
}

function finishToolCalls() {
  return { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
}

function finalText(text) {
  // 分两块模拟真实流式
  const half = Math.ceil(text.length / 2);
  return [
    { choices: [{ index: 0, delta: { role: "assistant", content: text.slice(0, half) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text.slice(half) }, finish_reason: "stop" }] },
  ];
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    // 请求日志（toolCallsDone 由下方统一计算，这里只打日志）
    const lastToolResult = [...messages].reverse().find((m) => m.role === "tool");
    const callsDone = messages.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length).length;
    const systemText = messages.find((m) => m.role === "system" && typeof m.content === "string")?.content || "";
    console.log(`[mock] ${new Date().toISOString()} callsDone=${callsDone} lastTool=${lastToolResult?.name || "-"} toolResult=${String(lastToolResult?.content || "").slice(0, 150)}`);
    const lastUser = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
    const joined = messages.filter((m) => typeof m.content === "string").map((m) => m.content).join("\n");
    const userText = String(lastUser?.content || "");

    // 提取 workdir（系统提示中的绝对路径）
    const workdir = extractWorkdir(joined) || "D:/Projects/go-ai/.data/agentscope-ws";

    // 轮次：历史中 assistant tool_calls 数量 = 已执行工具数
    let toolCallsDone = 0;
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) toolCallsDone++;
    }

    let task = "md";
    if (/删除重复行|data\.csv|排序/.test(userText + joined)) task = "csv";
    else if (/截图|reference\.png|重做.*html/.test(userText + joined)) task = "html";

    const inputFile = task === "csv" ? "input/data.csv" : task === "html" ? "input/index.html" : "input/note.md";
    const outputFile = task === "csv" ? "output/data.csv" : task === "html" ? "output/index.html" : "output/article.md";

    let chunks = [];
    if (toolCallsDone === 0) {
      // 第一轮：读取 input 文件
      chunks.push(toolChunk("call_read_1", "Read", JSON.stringify({ file_path: `${workdir}/${inputFile}` })));
      chunks.push(finishToolCalls());
    } else if (toolCallsDone === 1) {
      // 第二轮：写 output 文件（内容按任务）
      let content = "";
      if (task === "md") {
        content = "# 结构化文章\n\n## 背景\n\n本文整理自会议纪要。\n\n## 要点\n\n- Q3 核心目标：提升转化率、降低流失、发布新功能。\n\n## 结论\n\n团队将围绕转化率与留存推进 Q3 交付。\n";
      } else if (task === "csv") {
        content = "name,score\nbob,10\ncarol,20\nalice,30\n";
      } else {
        content = '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;background:#0b0f1a;color:#e8ecf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{width:720px;background:linear-gradient(135deg,#1b2340,#141a30);border:1px solid #2a3456;border-radius:16px;padding:40px}.badge{background:rgba(59,130,246,.15);color:#93c5fd;border:1px solid rgba(59,130,246,.35);font-size:13px;padding:4px 12px;border-radius:999px}.btn{display:inline-block;background:#3b82f6;color:#fff;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:28px}.tile{background:#202a4a;border:1px solid #2c3a63;border-radius:10px;padding:16px;text-align:center}</style></head><body><div class="card"><span class="badge">Cloud AI Work System</span><h1>Go AI 云工作台</h1><p>把文件任务交给云端 Agent。</p><a class="btn" href="#">开始使用</a><div class="grid"><div class="tile"><strong>文件理解</strong>解析输入</div><div class="tile"><strong>Agent 执行</strong>沙盒修改</div><div class="tile"><strong>产物交付</strong>验证注册</div></div></div></body></html>\n';
      }
      chunks.push(toolChunk("call_write_1", "Write", JSON.stringify({ file_path: `${workdir}/${outputFile}`, content })));
      chunks.push(finishToolCalls());
    } else {
      // 完成：纯文本
      chunks = finalText(`已完成任务：${task} 任务，交付文件 ${outputFile}（位于 ${workdir}/${outputFile}）。`);
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of chunks) res.write(sse(chunk));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock llm on 127.0.0.1:${PORT}`));
