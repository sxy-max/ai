import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import net from "node:net";
import { GoFileAgentAdapter } from "../../lib/sandbox/dockerClaudeCode";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

function startContainer(): Promise<{ port: number; requests: Record<string, unknown>[]; close: () => Promise<void> }> {
  const requests: Record<string, unknown>[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(payload);
        const behavior = String((payload as { prompt?: string }).prompt || "");
        if (behavior.includes("cause-http-error")) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "container busy" }));
          return;
        }
        if (behavior.includes("cause-premature-end")) {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end('{"type":"agent_text","text":"half"}\n');
          return;
        }
        if (behavior.includes("cause-nonzero-exit")) {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end([
            '{"type":"agent_tool","name":"Read"}',
            '{"type":"agent_result","result":"done partial"}',
            '{"type":"done","exitCode":1}',
          ].join("\n") + "\n");
          return;
        }
        if (behavior.includes("cause-hang")) {
          // 流挂死：发送头 + 一个事件后永不结束（Claude Code 卡死场景）
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write('{"type":"agent_tool","name":"Read"}\n');
          return;
        }
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end([
          '{"type":"agent_tool","name":"Read","detail":"read a.md"}',
          '{"type":"agent_text","text":"正在处理"}',
          '{"type":"agent_result","result":"已完成"}',
          '{"type":"artifacts","files":[{"name":"output/report.md"}]}',
          '{"type":"done","exitCode":0}',
        ].join("\n") + "\n");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("1. 正常流：工具/文本/结果/artifacts/done 归一化映射，且请求体完整", async () => {
  const container = await startContainer();
  try {
    const adapter = new GoFileAgentAdapter({ agentUrl: `http://127.0.0.1:${container.port}` });
    const events: string[] = [];
    const result = await adapter.run(
      { job: { conversationId: "conv1", jobId: "job1" }, prompt: "改一下", model: "deepseek-v4-flash", memory: ["m"], style: "简洁", skills: ["s"], visionMd: true },
      (event) => { events.push(event.type); }
    );
    assert.deepEqual(events, ["tool", "text", "result", "artifacts", "done"]);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.partial, false);

    const req = container.requests[0];
    assert.equal(req.conversationId, "conv1");
    assert.equal(req.jobId, "job1");
    assert.equal(req.prompt, "改一下");
    assert.equal(req.model, "deepseek-v4-flash");
    assert.equal(req.maxTurns, 15);
    assert.deepEqual(req.memory, ["m"]);
    assert.equal(req.style, "简洁");
    assert.deepEqual(req.skills, ["s"]);
    assert.equal(req.visionMd, true);
  } finally {
    await container.close();
  }
});

test("2. 非零 exitCode → ok:true 但 partial:true", async () => {
  const container = await startContainer();
  try {
    const adapter = new GoFileAgentAdapter({ agentUrl: `http://127.0.0.1:${container.port}` });
    const result = await adapter.run({ job: { conversationId: "c", jobId: "j" }, prompt: "cause-nonzero-exit" }, () => {});
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.partial, true);
  } finally {
    await container.close();
  }
});

test("3. HTTP 非 200 → {ok:false, error:sandbox_http_*} 并发出 error 事件", async () => {
  const container = await startContainer();
  try {
    const adapter = new GoFileAgentAdapter({ agentUrl: `http://127.0.0.1:${container.port}` });
    const events: string[] = [];
    const result = await adapter.run({ job: { conversationId: "c", jobId: "j" }, prompt: "cause-http-error" }, (event) => {
      if (event.type === "error") events.push(event.message);
    });
    assert.equal(result.ok, false);
    assert.ok(String(result.error).startsWith("sandbox_http_503"));
    assert.equal(events.length, 1);
    assert.ok(events[0].includes("sandbox_http_503"));
  } finally {
    await container.close();
  }
});

test("4. 流提前结束（无 done）→ sandbox_stream_ended_prematurely", async () => {
  const container = await startContainer();
  try {
    const adapter = new GoFileAgentAdapter({ agentUrl: `http://127.0.0.1:${container.port}` });
    const result = await adapter.run({ job: { conversationId: "c", jobId: "j" }, prompt: "cause-premature-end" }, () => {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "sandbox_stream_ended_prematurely");
  } finally {
    await container.close();
  }
});

test("5. 超时（服务端不响应）→ sandbox_timeout 并发出 error 事件", async () => {
  const port = await freePort();
  const server = http.createServer(() => { /* 永不响应 */ });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    const adapter = new GoFileAgentAdapter({ agentUrl: `http://127.0.0.1:${port}`, timeoutMs: 60 });
    const messages: string[] = [];
    const result = await adapter.run({ job: { conversationId: "c", jobId: "j" }, prompt: "x" }, (event) => {
      if (event.type === "error") messages.push(event.message);
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "sandbox_timeout");
    assert.deepEqual(messages, ["沙箱执行超时"]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("6. 连接失败（服务未监听）→ sandbox_unavailable", async () => {
  const port = await freePort(); // 端口已释放，无监听
  const adapter = new GoFileAgentAdapter({ agentUrl: `http://127.0.0.1:${port}` });
  const result = await adapter.run({ job: { conversationId: "c", jobId: "j" }, prompt: "x" }, () => {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "sandbox_unavailable");
});

test("7. 流挂死（响应头已到但事件流永不结束）→ 仍按 timeoutMs 超时 sandbox_timeout", async () => {
  const container = await startContainer();
  try {
    const adapter = new GoFileAgentAdapter({ agentUrl: `http://127.0.0.1:${container.port}`, timeoutMs: 400 });
    const started = Date.now();
    const result = await adapter.run({ job: { conversationId: "c", jobId: "j" }, prompt: "cause-hang" }, () => {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "sandbox_timeout");
    assert.ok(Date.now() - started < 8000, "必须由超时终止，而非无限挂起");
  } finally {
    await container.close();
  }
});
