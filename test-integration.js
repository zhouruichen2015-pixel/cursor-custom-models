// ============================================================
// 集成测试 v1.2: 模拟 Cursor transport + protobuf-es v2 消息类型 + Mock SSE
// 覆盖: 消息提取 / 模型映射 / SSE解析 / oneof包装响应构造 /
//       CmdK编辑协议 / Agent包装响应 / streamStart / BiDi合并 / 透传 / 错误处理 /
//       agent.v1.AgentService/Run 协议(Agents 界面: 心跳/textDelta/thinkingDelta/
//       turnEnded 单次/多轮记忆/空回复兜底)
// ============================================================
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const SLOW_ONLY = !!process.env.CM_SLOW_ONLY; // 子进程模式: 只跑 T18/T19(隔离 Node24/Win libuv abort 断言)

const PORT = SLOW_ONLY ? 3998 : 3999; // 子进程用独立端口, 避免与父进程 EADDRINUSE
let lastRequestBody = null;
let sseScript = null; // 可切换的 SSE 输出脚本
let sseQueue = [];    // 多轮脚本队列(工具循环测试): 每次上游请求弹出一个
const requestBodies = []; // 记录每次上游请求体
let slowMode = false; // 慢速滴流模式(每块间隔80ms)

// ---------- protobuf-es v2 消息类型 mock ----------
function camel(s) { return s.replace(/_([a-zA-Z])/g, (m, c) => c.toUpperCase()); }

function applyPartial(target, src, T) {
  if (src === undefined || src === null) return target;
  const members = T.fields.byMember();
  for (const m of members) {
    if (m.kind === "oneof") {
      const v = src[m.localName];
      if (v && v.case) {
        let val = v.value;
        const f = m.findField(v.case); // 忠实模拟 v2 initPartial: message 值包装为实例
        if (f && f.kind === "message" && val !== null && val !== undefined && !(val instanceof f.T)) val = new f.T(val);
        target[m.localName] = { case: v.case, value: val };
      }
    } else if (src[m.localName] !== undefined && src[m.localName] !== null) {
      const v = src[m.localName];
      if (m.kind === "message" && !m.repeated) {
        target[m.localName] = (v instanceof m.T) ? v : new m.T(v);
      } else if (m.kind === "message" && m.repeated) {
        target[m.localName] = v.map((x) => (x instanceof m.T ? x : new m.T(x)));
      } else {
        target[m.localName] = v;
      }
    }
  }
  return target;
}

function makeType(typeName, fieldDefs) {
  const oneofs = {};
  const members = [];
  for (const f of fieldDefs) {
    const info = { no: f.no, name: f.name, localName: camel(f.name), kind: f.kind, T: f.T, repeated: !!f.repeated, opt: !!f.opt };
    if (f.oneof) {
      if (!oneofs[f.oneof]) {
        const oi = { localName: f.oneof, kind: "oneof", fields: [], findField: (n) => oi.fields.find((x) => x.localName === n) };
        oneofs[f.oneof] = oi;
        members.push(oi);
      }
      info.oneof = oneofs[f.oneof];
      oneofs[f.oneof].fields.push(info);
    } else {
      members.push(info);
    }
  }
  class T {
    constructor(partial) { applyPartial(this, partial, T); }
  }
  T.typeName = typeName;
  T.fields = { byMember: () => members };
  return T;
}

// 真实 Cursor proto 结构复刻
const ThinkingT = makeType("aiserver.v1.ConversationMessage.Thinking", [
  { no: 1, name: "text", kind: "scalar" }
]);
const SFt = makeType("aiserver.v1.StreamUnifiedChatResponse", [
  { no: 1, name: "text", kind: "scalar" },
  { no: 25, name: "thinking", kind: "message", T: ThinkingT, opt: true },
  { no: 13, name: "tool_call", kind: "scalar", opt: true }
]);
const StreamStartT = makeType("aiserver.v1.StreamStart", [
  { no: 1, name: "padding", kind: "scalar" }
]);
const BTe = makeType("aiserver.v1.StreamUnifiedChatResponseWithTools", [
  { no: 1, name: "client_side_tool_v2_call", kind: "scalar", oneof: "response" },
  { no: 2, name: "stream_unified_chat_response", kind: "message", T: SFt, oneof: "response" },
  { no: 5, name: "stream_start", kind: "message", T: StreamStartT, oneof: "response" }
]);
const WelcomeT = makeType("aiserver.v1.WelcomeMessage", [
  { no: 1, name: "message", kind: "scalar" }
]);
const VEi = makeType("aiserver.v1.StreamUnifiedChatResponseWithToolsIdempotent", [
  { no: 1, name: "server_chunk", kind: "message", T: BTe, oneof: "response" },
  { no: 3, name: "welcome_message", kind: "message", T: WelcomeT, oneof: "response" },
  { no: 4, name: "seqno_ack", kind: "scalar", oneof: "response" }
]);
const EditStartT = makeType("aiserver.v1.StreamCmdKResponse.EditStart", [
  { no: 1, name: "start_line_number", kind: "scalar" },
  { no: 2, name: "edit_id", kind: "scalar" },
  { no: 3, name: "max_end_line_number_exclusive", kind: "scalar", opt: true }
]);
const EditStreamT = makeType("aiserver.v1.StreamCmdKResponse.EditStream", [
  { no: 1, name: "text", kind: "scalar" },
  { no: 2, name: "edit_id", kind: "scalar" }
]);
const EditEndT = makeType("aiserver.v1.StreamCmdKResponse.EditEnd", [
  { no: 1, name: "end_line_number_exclusive", kind: "scalar" },
  { no: 2, name: "edit_id", kind: "scalar" }
]);
const CmdKChatT = makeType("aiserver.v1.StreamCmdKResponse.Chat", [
  { no: 1, name: "text", kind: "scalar" }
]);
const Zyn = makeType("aiserver.v1.StreamCmdKResponse", [
  { no: 1, name: "edit_start", kind: "message", T: EditStartT, oneof: "response" },
  { no: 2, name: "edit_stream", kind: "message", T: EditStreamT, oneof: "response" },
  { no: 3, name: "edit_end", kind: "message", T: EditEndT, oneof: "response" },
  { no: 4, name: "chat", kind: "message", T: CmdKChatT, oneof: "response" }
]);
const Yxs = makeType("aiserver.v1.StreamCmdKResponseContextWrapped", [
  { no: 1, name: "real_response", kind: "message", T: Zyn, oneof: "response" },
  { no: 2, name: "context_status_update", kind: "scalar", oneof: "response" }
]);

// agent.v1 (Cursor Agents 界面) 协议类型复刻 — 与 glass 包实测 dump 的结构一致
const AgentUserMessageT = makeType("agent.v1.UserMessage", [
  { no: 1, name: "text", kind: "scalar" }
]);
const AgentRuleT = makeType("agent.v1.CursorRule", [
  { no: 1, name: "full_path", kind: "scalar" },
  { no: 2, name: "content", kind: "scalar" }
]);
const AgentEnvT = makeType("agent.v1.RequestContextEnv", [
  { no: 1, name: "os_version", kind: "scalar" },
  { no: 2, name: "workspace_paths", kind: "scalar", repeated: true },
  { no: 3, name: "shell", kind: "scalar" },
  { no: 10, name: "time_zone", kind: "scalar" },
  { no: 11, name: "project_folder", kind: "scalar" },
  { no: 12, name: "terminals_folder", kind: "scalar" }
]);
const AgentRepoInfoT = makeType("agent.v1.RepositoryIndexingInfo", [
  { no: 1, name: "relative_workspace_path", kind: "scalar" },
  { no: 2, name: "remote_urls", kind: "scalar", repeated: true },
  { no: 4, name: "repo_name", kind: "scalar" },
  { no: 5, name: "repo_owner", kind: "scalar" }
]);
const AgentLayoutFileT = makeType("agent.v1.LsFileTreeNode", [
  { no: 1, name: "abs_path", kind: "scalar" }
]);
const AgentLayoutNodeT = makeType("agent.v1.LsDirectoryTreeNode", [
  { no: 1, name: "abs_path", kind: "scalar" },
  { no: 3, name: "children_files", kind: "message", T: AgentLayoutFileT, repeated: true },
  { no: 6, name: "num_files", kind: "scalar" }
]);
const AgentMcpInstructionT = makeType("agent.v1.McpInstructions", [
  { no: 1, name: "server_name", kind: "scalar" },
  { no: 2, name: "instructions", kind: "scalar" }
]);
const AgentToolT = makeType("agent.v1.Tool", [
  { no: 1, name: "name", kind: "scalar" },
  { no: 2, name: "description", kind: "scalar" },
  { no: 3, name: "provider_identifier", kind: "scalar" },
  { no: 4, name: "tool_name", kind: "scalar" },
  { no: 5, name: "input_schema_json", kind: "scalar" }
]);
const AgentRequestContextT = makeType("agent.v1.RequestContext", [
  { no: 2, name: "rules", kind: "message", T: AgentRuleT, repeated: true },
  { no: 4, name: "env", kind: "message", T: AgentEnvT },
  { no: 6, name: "repository_info", kind: "message", T: AgentRepoInfoT, repeated: true },
  { no: 8, name: "mcp_instructions", kind: "message", T: AgentMcpInstructionT, repeated: true },
  { no: 9, name: "tools", kind: "message", T: AgentToolT, repeated: true },
  { no: 13, name: "project_layouts", kind: "message", T: AgentLayoutNodeT, repeated: true }
]);
// 真实结构(3.16.17 E2E dump 实证): requestContext 嵌在 UserMessageAction 层
// (action.userMessageAction.requestContext), 而非顶层 runRequest.requestContext;
// RunRequest.action 是 message 字段(Action 类型), Action 内部才有 "action" oneof
const AgentUserMessageActionT = makeType("agent.v1.UserMessageAction", [
  { no: 1, name: "user_message", kind: "message", T: AgentUserMessageT },
  { no: 2, name: "request_context", kind: "message", T: AgentRequestContextT }
]);
const AgentActionT = makeType("agent.v1.Action", [
  { no: 1, name: "user_message_action", kind: "message", T: AgentUserMessageActionT, oneof: "action" }
]);
const AgentRunRequestT = makeType("agent.v1.RunRequest", [
  { no: 1, name: "conversation_id", kind: "scalar" },
  { no: 2, name: "action", kind: "message", T: AgentActionT },
  { no: 3, name: "custom_system_prompt", kind: "scalar" },
  { no: 4, name: "request_context", kind: "message", T: AgentRequestContextT }
]);
// 工具调用往返类型 (v1.5)
const ReadToolArgsT = makeType("agent.v1.ReadToolArgs", [
  { no: 1, name: "path", kind: "scalar" },
  { no: 2, name: "offset", kind: "scalar", opt: true },
  { no: 3, name: "limit", kind: "scalar", opt: true }
]);
const ReadFileResultT = makeType("agent.v1.ReadFileResult", [
  { no: 1, name: "content", kind: "scalar" }
]);
const ReadToolCallT = makeType("agent.v1.ReadToolCall", [
  { no: 1, name: "args", kind: "message", T: ReadToolArgsT },
  { no: 2, name: "result", kind: "message", T: ReadFileResultT }
]);
const AgentToolCallT = makeType("agent.v1.ToolCall", [
  { no: 8, name: "read_tool_call", kind: "message", T: ReadToolCallT, oneof: "tool" }
]);
const ToolCallStartedT = makeType("agent.v1.ToolCallStartedUpdate", [
  { no: 1, name: "call_id", kind: "scalar" },
  { no: 2, name: "tool_call", kind: "message", T: AgentToolCallT }
]);
const ToolCallCompletedT = makeType("agent.v1.ToolCallCompletedUpdate", [
  { no: 1, name: "call_id", kind: "scalar" },
  { no: 2, name: "tool_call", kind: "message", T: AgentToolCallT }
]);
const ExecClientMessageT = makeType("agent.v1.ExecClientMessage", [
  { no: 1, name: "id", kind: "scalar" },
  { no: 15, name: "exec_id", kind: "scalar" },
  { no: 7, name: "read_result", kind: "message", T: ReadFileResultT, oneof: "message" }
]);
// ExecServerMessage — 真正驱动客户端执行工具的指令通道(v1.5.1 三段式协议)
const ReadArgsT = makeType("agent.v1.ReadArgs", [
  { no: 1, name: "path", kind: "scalar" },
  { no: 2, name: "tool_call_id", kind: "scalar" },
  { no: 4, name: "offset", kind: "scalar", opt: true },
  { no: 5, name: "limit", kind: "scalar", opt: true }
]);
const GrepArgsT = makeType("agent.v1.GrepArgs", [
  { no: 1, name: "pattern", kind: "scalar" },
  { no: 2, name: "path", kind: "scalar", opt: true },
  { no: 3, name: "glob", kind: "scalar", opt: true },
  { no: 4, name: "output_mode", kind: "scalar", opt: true },
  { no: 5, name: "context_before", kind: "scalar", opt: true },
  { no: 6, name: "context_after", kind: "scalar", opt: true }
]);
const LsArgsT = makeType("agent.v1.LsArgs", [
  { no: 1, name: "path", kind: "scalar" },
  { no: 3, name: "tool_call_id", kind: "scalar" }
]);
const ExecServerMessageT = makeType("agent.v1.ExecServerMessage", [
  { no: 1, name: "id", kind: "scalar" },
  { no: 15, name: "exec_id", kind: "scalar" },
  { no: 7, name: "read_args", kind: "message", T: ReadArgsT, oneof: "message" },
  { no: 5, name: "grep_args", kind: "message", T: GrepArgsT, oneof: "message" },
  { no: 8, name: "ls_args", kind: "message", T: LsArgsT, oneof: "message" }
]);
const AgentClientMsgT = makeType("agent.v1.AgentClientMessage", [
  { no: 1, name: "run_request", kind: "message", T: AgentRunRequestT, oneof: "message" },
  { no: 2, name: "exec_client_message", kind: "message", T: ExecClientMessageT, oneof: "message" }
]);
const AgentHeartbeatT = makeType("agent.v1.Heartbeat", [{ no: 1, name: "padding", kind: "scalar" }]);
const AgentThinkingDeltaT = makeType("agent.v1.ThinkingDeltaUpdate", [{ no: 1, name: "text", kind: "scalar" }]);
const AgentTextDeltaT = makeType("agent.v1.TextDeltaUpdate", [{ no: 1, name: "text", kind: "scalar" }]);
const AgentTurnEndedT = makeType("agent.v1.TurnEndedUpdate", [{ no: 1, name: "reason", kind: "scalar" }]);
const AgentInteractionT = makeType("agent.v1.Interaction", [
  { no: 1, name: "heartbeat", kind: "message", T: AgentHeartbeatT, oneof: "message" },
  { no: 2, name: "thinking_delta", kind: "message", T: AgentThinkingDeltaT, oneof: "message" },
  { no: 3, name: "text_delta", kind: "message", T: AgentTextDeltaT, oneof: "message" },
  { no: 4, name: "turn_ended", kind: "message", T: AgentTurnEndedT, oneof: "message" },
  { no: 5, name: "tool_call_started", kind: "message", T: ToolCallStartedT, oneof: "message" },
  { no: 6, name: "tool_call_completed", kind: "message", T: ToolCallCompletedT, oneof: "message" }
]);
const AgentServerMsgT = makeType("agent.v1.AgentServerMessage", [
  { no: 1, name: "interaction_update", kind: "message", T: AgentInteractionT, oneof: "message" },
  { no: 2, name: "exec_server_message", kind: "message", T: ExecServerMessageT, oneof: "message" }
]);

// ---------- Mock OpenAI 兼容 SSE 服务器 ----------
const liveRes = new Set(); // 跟踪活跃响应, 退出前销毁避免 libuv 断言
const server = http.createServer((req, res) => {
  liveRes.add(res);
  res.on("close", () => liveRes.delete(res));
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastRequestBody = JSON.parse(body);
      requestBodies.push(lastRequestBody);
      const script = sseQueue.length ? sseQueue.shift() : (sseScript || [
        { delta: { content: "你好" } },
        { delta: { content: "，我是" } },
        { delta: { content: "DeepSeek" } }
      ]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (slowMode) {
        (async () => {
          for (const s of script) {
            if (res.destroyed || res.writableEnded) return; // 客户端abort后停止写入, 避免write-after-abort
            try { res.write(`data: ${JSON.stringify({ choices: [{ delta: s.delta }] })}\n\n`); } catch (e) { return; }
            await new Promise((r2) => setTimeout(r2, 80));
          }
          if (res.destroyed || res.writableEnded) return;
          try { res.write("data: [DONE]\n\n"); res.end(); } catch (e) { /* noop */ }
        })();
        return;
      }
      for (const s of script) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: s.delta }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[mock] listening on ${PORT}`);
  let pass = 0, fail = 0;
  function T(name, ok, extra) {
    if (ok) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name}${extra ? " | " + extra : ""}`); }
  }
  try {
    await runTests(T);
  } catch (e) {
    console.error("[ERROR]", e);
    process.exitCode = 1;
  } finally {
    if (SLOW_ONLY) {
      // 子进程: 打印完立即硬退, 规避 libuv 拆除断言(父进程按 stdout 判定, 不看退出码)
      console.log(`\n===== slow-child: ${pass} passed, ${fail} failed =====`);
      process.exit(fail > 0 ? 1 : 0);
    }
    console.log(`\n===== ${pass} passed, ${fail} failed =====`);
    try { server.close(); } catch (e) { /* noop */ } // 父进程无 aborted 连接, close 安全且必要(否则挂起)
    process.exitCode = fail > 0 ? 1 : 0;
  }
});

async function collect(stream) {
  const out = [];
  for await (const m of stream) out.push(m);
  return out;
}

async function runTests(T) {
  if (SLOW_ONLY) {
    // ---- 子进程模式: 仅 T18/T19 ----
    const cfgSlow = {
      enabled: true,
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      apiKey: "sk-test-key",
      defaultModel: "deepseek-v4-flash",
      modelMapping: { "*": "deepseek-v4-flash" },
      interceptMethods: ["aiserver.v1.ChatService/StreamUnifiedChat"],
      temperature: null, maxTokens: null, extraHeaders: {}, sendReasoningAsText: false
    };
    const srcSlow = fs.readFileSync(path.join(__dirname, "cm-runtime.js"), "utf8")
      .replace("__CM_CONFIG_PLACEHOLDER__", JSON.stringify(cfgSlow));
    new Function(srcSlow)();
    const cmS = globalThis.__CURSOR_CM__;
    const svcChatS = { typeName: "aiserver.v1.ChatService" };
    const mUnifiedS = { name: "StreamUnifiedChat", O: SFt, kind: 1 };
    const origS = {
      unary: async () => ({ stream: false, message: {} }),
      stream: async () => { async function* o() { yield "ORIG"; } return { stream: true, message: o(), header: new Headers(), trailer: new Headers() }; }
    };
    const wS = cmS.wrap(origS);
    const chatReqS = { conversation: [{ type: 1, text: "hi" }], modelDetails: { modelName: "gpt-4" } };
    const one = (m) => (async function* () { yield m; })();

    sseScript = [{ delta: { content: "a1" } }, { delta: { content: "a2" } }, { delta: { content: "a3" } }];
    slowMode = true;
    try {
      const er = await wS.stream(svcChatS, mUnifiedS, null, null, {}, one(chatReqS));
      const iter = er.message[Symbol.asyncIterator]();
      await iter.next();
      const t0 = Date.now();
      await iter.return();
      T("T18 提前return清理(及时终止)", (Date.now() - t0) < 2000);
    } catch (e) { T("T18 提前return清理(及时终止)", false, e.message); }

    sseScript = [{ delta: { content: "b1" } }, { delta: { content: "b2" } }, { delta: { content: "b3" } }];
    try {
      const ac = new AbortController();
      const ar = await wS.stream(svcChatS, mUnifiedS, ac.signal, null, {}, one(chatReqS));
      const it19 = ar.message[Symbol.asyncIterator]();
      await it19.next();
      ac.abort();
      let abortErr = null;
      try { while (!(await it19.next()).done) { /* drain */ } }
      catch (e) { abortErr = e; }
      T("T19 abort→AbortError传播", abortErr !== null && /abort/i.test(abortErr.name + abortErr.message));
    } catch (e) { T("T19 abort→AbortError传播", false, e.message); }
    slowMode = false;
    return;
  }

  const cfg = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    apiKey: "sk-test-key",
    defaultModel: "deepseek-v4-flash",
    modelMapping: { "*": "deepseek-v4-flash", "gpt-4": "deepseek-v4-pro" },
    interceptMethods: [
      "aiserver.v1.ChatService/StreamUnifiedChat",
      "aiserver.v1.ChatService/StreamUnifiedChatWithTools",
      "aiserver.v1.ChatService/StreamUnifiedChatWithToolsIdempotent",
      "aiserver.v1.CmdKService/StreamCmdK",
      "agent.v1.AgentService/Run"
    ],
    temperature: null, maxTokens: null, extraHeaders: {}, sendReasoningAsText: false
  };

  const runtimeSrc = fs.readFileSync(path.join(__dirname, "cm-runtime.js"), "utf8")
    .replace("__CM_CONFIG_PLACEHOLDER__", JSON.stringify(cfg));
  new Function(runtimeSrc)();
  const cm = globalThis.__CURSOR_CM__;
  T("T1 runtime active", cm.active === true && /^1\./.test(String(cm.version)));

  const svcChat = { typeName: "aiserver.v1.ChatService" };
  const svcCmdK = { typeName: "aiserver.v1.CmdKService" };
  const svcOther = { typeName: "aiserver.v1.AuthService" };
  const mUnified = { name: "StreamUnifiedChat", O: SFt, kind: 1 };
  const mWithTools = { name: "StreamUnifiedChatWithTools", O: BTe, kind: 3 };
  const mSSE = { name: "StreamUnifiedChatWithToolsSSE", O: BTe, kind: 1 }; // 轮询通道, 不拦截
  const mIdem = { name: "StreamUnifiedChatWithToolsIdempotent", O: VEi, kind: 3 };
  const mCmdK = { name: "StreamCmdK", O: Yxs, kind: 1 };
  const mOther = { name: "SomeAuthMethod" };

  const origCalls = [];
  const origTransport = {
    unary: async (...a) => { origCalls.push(["unary", a[0].typeName, a[1].name]); return { stream: false, message: {} }; },
    stream: async (...a) => {
      origCalls.push(["stream", a[0].typeName, a[1].name]);
      async function* out() { yield "ORIG"; }
      // 与真实 Cursor transport 一致: 字段名是 message (源码 callSharedConnectStream 消费 _.message)
      return { stream: true, message: out(), header: new Headers(), trailer: new Headers() };
    },
    close() { origCalls.push(["close"]); },
    customProp: 42
  };
  const wrapped = cm.wrap(origTransport);
  const oneMsg = (m) => (async function* () { yield m; })();

  // T2/T3: 透传
  sseScript = null;
  let r = await wrapped.stream(svcOther, mOther, null, null, {}, oneMsg({}));
  T("T2 非目标 stream 透传", (await collect(r.message))[0] === "ORIG");
  await wrapped.unary(svcOther, mOther, null, null, {}, {});
  T("T3 非目标 unary 透传", origCalls.some((c) => c[0] === "unary" && c[2] === "SomeAuthMethod"));

  // T4/T5: StreamUnifiedChat 直接 text 响应 + 提取与映射
  sseScript = [{ delta: { content: "A" } }, { delta: { content: "B" } }];
  const chatReq = {
    conversation: [
      { type: 1, text: "写hello world", attachedCodeChunks: [{ relativeWorkspacePath: "main.py", lines: ["print(1)"] }] },
      { type: 2, text: "好的" },
      { type: 1, text: "继续" }
    ],
    modelDetails: { modelName: "gpt-4" }
  };
  r = await wrapped.stream(svcChat, mUnified, null, null, {}, oneMsg(chatReq));
  const chatMsgs = await collect(r.message);
  const chatText = chatMsgs.map((m) => m.text).join("");
  T("T4 Chat直接text响应", chatText === "AB" && chatMsgs[0] instanceof SFt);
  const msgs = lastRequestBody.messages;
  T("T5 消息提取+模型映射",
    msgs.length === 3 && msgs[0].role === "user" && msgs[0].content.includes("print(1)") &&
    msgs[1].role === "assistant" && lastRequestBody.model === "deepseek-v4-pro" && lastRequestBody.stream === true);

  // T6: Agent 包装响应 (BTe): 先 streamStart, 再 streamUnifiedChatResponse.text
  sseScript = [{ delta: { content: "X" } }, { delta: { content: "Y" } }];
  r = await wrapped.stream(svcChat, mWithTools, null, null, {}, oneMsg({
    request: { case: "streamUnifiedChatRequest", value: { conversation: [{ type: 1, text: "hi" }], modelDetails: { modelName: "gpt-4" } } }
  }));
  const bidiMsgs = await collect(r.message);
  const okBidi = bidiMsgs[0] instanceof BTe &&
    bidiMsgs[0].response && bidiMsgs[0].response.case === "streamStart" &&
    bidiMsgs.slice(1).every((m) => m.response.case === "streamUnifiedChatResponse" && m.response.value instanceof SFt) &&
    bidiMsgs.slice(1).map((m) => m.response.value.text).join("") === "XY";
  T("T6 Agent包装响应(BTe)含streamStart", okBidi, JSON.stringify(bidiMsgs.map((m) => m.response && m.response.case)));

  // T7: SSE 变体是轮询通道(BidiRequestId), 默认不拦截 → 透传
  r = await wrapped.stream(svcChat, mSSE, null, null, {}, oneMsg({ requestId: "abc" }));
  T("T7 SSE轮询通道不拦截(透传)", (await collect(r.message))[0] === "ORIG");

  // T8: CmdK 编辑协议（有选区）
  sseScript = [{ delta: { content: "line1\n" } }, { delta: { content: "line2" } }];
  const cmdkReq = {
    contextItems: [
      { contextItem: { item: { case: "cmdKQuery", value: { query: "加注释" } } } },
      { contextItem: { item: { case: "cmdKSelection", value: { lines: ["a", "b"], startLineNumber: 10 } } } },
      { contextItem: { item: { case: "cmdKImmediateContext", value: { relativeWorkspacePath: "x.py", lines: [{ line: "ctx1", lineNumber: 8 }, { line: "ctx2", lineNumber: 9 }] } } } }
    ],
    cmdKOptions: { modelDetails: { modelName: "auto" } }
  };
  r = await wrapped.stream(svcCmdK, mCmdK, null, null, {}, oneMsg(cmdkReq));
  const cmdkMsgs = await collect(r.message);
  const unwrap = (m) => m.response && m.response.case === "realResponse" ? m.response.value.response : null;
  const startM = cmdkMsgs.map(unwrap).find((x) => x && x.case === "editStart");
  const streamMs = cmdkMsgs.map(unwrap).filter((x) => x && x.case === "editStream");
  const endM = cmdkMsgs.map(unwrap).find((x) => x && x.case === "editEnd");
  T("T8 CmdK编辑协议(二级oneof)",
    !!startM && startM.value.startLineNumber === 10 && startM.value.editId === 1 &&
    streamMs.length === 2 && streamMs.map((m) => m.value.text).join("") === "line1\nline2" &&
    !!endM && endM.value.endLineNumberExclusive === 12 && // 10 + 2行
    cmdkMsgs[0] instanceof Yxs);

  // T9: 上游提示词含 query+选区+文件上下文
  const c = lastRequestBody.messages[0].content;
  T("T9 CmdK提示词组装", c.includes("加注释") && c.includes("a\nb") && c.includes("ctx1") && c.includes("x.py") && lastRequestBody.model === "deepseek-v4-flash");

  // T10: CmdK 无选区 → chat 流
  sseScript = [{ delta: { content: "回答" } }];
  r = await wrapped.stream(svcCmdK, mCmdK, null, null, {}, oneMsg({
    contextItems: [{ contextItem: { item: { case: "cmdKQuery", value: { query: "解释" } } } }]
  }));
  const chat2 = await collect(r.message);
  const chatUnwrapped = chat2.map(unwrap).filter((x) => x && x.case === "chat");
  T("T10 CmdK无选区→chat流", chatUnwrapped.length === 1 && chatUnwrapped[0].value.text === "回答");

  // T11: thinking 映射
  sseScript = [{ delta: { reasoning_content: "想一下" } }, { delta: { content: "答" } }];
  r = await wrapped.stream(svcChat, mUnified, null, null, {}, oneMsg(chatReq));
  const thinkMsgs = await collect(r.message);
  T("T11 thinking→SFt.thinking", thinkMsgs[0].thinking instanceof ThinkingT && thinkMsgs[0].thinking.text === "想一下" && thinkMsgs[1].text === "答");

  // T12: 上游不可达 → 抛错
  const cmBad = new Function(runtimeSrc.replace(JSON.stringify(cfg), JSON.stringify({ ...cfg, baseUrl: "http://127.0.0.1:1/v1" })) + "\n;return globalThis.__CURSOR_CM__.wrap;")();
  const wBad = cmBad(origTransport);
  let threw = false;
  try { await collect((await wBad.stream(svcChat, mUnified, null, null, {}, oneMsg(chatReq))).message); } catch (e) { threw = true; }
  T("T12 上游错误抛出", threw);

  // T13: 配置禁用 → 原通道
  const cmOff = new Function(runtimeSrc.replace('"enabled":true', '"enabled":false') + "\n;return globalThis.__CURSOR_CM__;")();
  const wOff = cmOff.wrap(origTransport);
  const offR = await wOff.stream(svcChat, mUnified, null, null, {}, oneMsg(chatReq));
  T("T13 禁用→原通道", (await collect(offR.message))[0] === "ORIG");

  // T14: close/属性透传
  wrapped.close();
  T("T14 close/属性透传", origCalls.some((x) => x[0] === "close") && wrapped.customProp === 42);

  // T15: BiDi 多条合并
  sseScript = [{ delta: { content: "ok" } }];
  r = await wrapped.stream(svcChat, mWithTools, null, null, {}, (async function* () {
    yield { request: { case: "streamUnifiedChatRequest", value: { conversation: [{ type: 1, text: "第一条" }], modelDetails: { modelName: "gpt-4" } } } };
    yield { request: { case: "streamUnifiedChatRequest", value: { conversation: [{ type: 1, text: "第二条" }], modelDetails: { modelName: "gpt-4" } } } };
  })());
  await collect(r.message);
  T("T15 BiDi多包合并", lastRequestBody.messages.length === 2 && lastRequestBody.messages[1].content === "第二条");

  // T16: Idempotent 通道: request.clientChunk → zEi.request.streamUnifiedChatRequest 两层递归解包
  //      响应 VEi.response.serverChunk(BTe).response.streamUnifiedChatResponse.text 三层包装
  sseScript = [{ delta: { content: "P" } }, { delta: { content: "Q" } }];
  r = await wrapped.stream(svcChat, mIdem, null, null, {}, (async function* () {
    yield {
      request: {
        case: "clientChunk",
        value: { request: { case: "streamUnifiedChatRequest", value: { conversation: [{ type: 1, text: "幂等请求" }], modelDetails: { modelName: "gpt-4" } } } }
      }
    };
    yield { request: { case: "abort", value: {} } }; // 控制包应被跳过
  })());
  const idemMsgs = await collect(r.message);
  const okIdem = idemMsgs.length >= 2 &&
    idemMsgs.every((m) => m instanceof VEi && m.response.case === "serverChunk") &&
    idemMsgs.map((m) => { const b = m.response.value; return b && b.response.case === "streamUnifiedChatResponse" ? b.response.value.text : ""; }).join("") === "PQ";
  T("T16 Idempotent两层解包+三层响应包装", okIdem && lastRequestBody.messages.length === 1 && lastRequestBody.messages[0].content === "幂等请求",
    JSON.stringify(idemMsgs.map((m) => m.response && m.response.case)));

  // T17: 返回结构契约(对齐真实 Cursor callSharedConnectStream 消费方式:
  //     for await(_.message) / _.header.entries() / _.trailer.entries())
  sseScript = [{ delta: { content: "契约" } }];
  const rr = await wrapped.stream(svcChat, mUnified, null, null, {}, oneMsg(chatReq));
  const contractOk = rr.stream === true &&
    rr.service === svcChat && rr.method === mUnified &&
    typeof rr.message[Symbol.asyncIterator] === "function" &&
    typeof rr.header.entries === "function" &&
    typeof rr.trailer.entries === "function" &&
    [...rr.header.entries()].length === 0; // entries() 是 Iterator, 与 Cursor 源码 [..._.header.entries()] 一致
  T("T17 stream返回结构契约(message/header/trailer)", contractOk);

  // T18/T19(abort/return 慢速流)在子进程运行: Node24/Win 的 http 栈对 localhost
  // abort 连接存在 libuv 断言 bug(async.c:76), 崩溃隔离在子进程, 父进程按 stdout 判定
  const slow = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, CM_SLOW_ONLY: "1" },
    encoding: "utf8", timeout: 30000
  });
  const slowOut = (slow.stdout || "") + (slow.stderr || "");
  const slowPass = (slowOut.match(/\[PASS\]/g) || []).length;
  const slowFail = (slowOut.match(/\[FAIL\]/g) || []).length;
  const slowSummary = slowOut.match(/slow-child: (\d+) passed, (\d+) failed/);
  const okSlow = slowSummary ? (+slowSummary[1] === 2 && +slowSummary[2] === 0) : false;
  T("T18+T19 abort/return清理(子进程隔离)", okSlow,
    `pass=${slowPass} fail=${slowFail} ${okSlow ? "" : slowOut.slice(-300)}`);

  // T20: Usage 门禁拦截 — DashboardService 两个 unary 返回空响应(无 HARD_BLOCK)
  const svcDash = { typeName: "aiserver.v1.DashboardService" };
  const RespGate = makeType("aiserver.v1.GetUsageLimitStatusAndActiveGrantsResponse", [
    { no: 1, name: "usage_limit_policy_status", kind: "message", T: makeType(".UsageLimitPolicyStatus", [{ no: 1, name: "is_in_slow_pool", kind: "scalar" }]), opt: true }
  ]);
  const mGate1 = { name: "GetUsageLimitStatusAndActiveGrants", I: {}, O: RespGate, kind: 0 };
  const mGate2 = { name: "GetUsageLimitPolicyStatus", I: {}, O: RespGate, kind: 0 };
  const g1 = await wrapped.unary(svcDash, mGate1, null, null, {}, {});
  const g2 = await wrapped.unary(svcDash, mGate2, null, null, {}, {});
  const gateOk = g1.stream === false && g1.message instanceof RespGate &&
    g1.message.usageLimitPolicyStatus === undefined &&
    g2.message instanceof RespGate && typeof g1.header.entries === "function";
  T("T20 usage门禁拦截(空响应)", gateOk);
  // T20b: 其它 DashboardService unary 透传(不误伤)
  const mOtherDash = { name: "GetCreditGrantsBalance", I: {}, O: RespGate, kind: 0 };
  await wrapped.unary(svcDash, mOtherDash, null, null, {}, {});
  T("T20b 非门禁unary透传", origCalls.some((x) => x[0] === "unary" && x[1] === "aiserver.v1.DashboardService" && x[2] === "GetCreditGrantsBalance"));

  // ================= agent.v1.AgentService/Run (Cursor Agents 界面) =================
  const svcAgent = { typeName: "agent.v1.AgentService" };
  const mAgentRun = { name: "Run", O: AgentServerMsgT, kind: 3 };
  const agentInner = (m) => (m.message && m.message.case === "interactionUpdate") ? m.message.value.message : null;
  const mkAgentReq = (convId, text, extra) => new AgentClientMsgT({
    message: { case: "runRequest", value: Object.assign({
      conversationId: convId,
      action: new AgentActionT({ action: { case: "userMessageAction", value: new AgentUserMessageActionT({ userMessage: new AgentUserMessageT({ text }) }) } })
    }, extra || {}) }
  });

  // T21: agent 基础流 — 心跳预发 + textDelta 流 + turnEnded 恰好一次
  sseScript = [{ delta: { content: "你" } }, { delta: { content: "好" } }];
  r = await wrapped.stream(svcAgent, mAgentRun, null, null, {}, oneMsg(mkAgentReq("conv-t21", "打个招呼")));
  const agentMsgs = await collect(r.message);
  const inners21 = agentMsgs.map(agentInner);
  const turnEndedCount = inners21.filter((x) => x && x.case === "turnEnded").length;
  const textJoined = inners21.filter((x) => x && x.case === "textDelta").map((x) => x.value.text).join("");
  T("T21 agent基础流(心跳+textDelta+turnEnded单次)",
    agentMsgs.every((m) => m instanceof AgentServerMsgT) &&
    inners21[0] && inners21[0].case === "heartbeat" &&
    textJoined === "你好" &&
    turnEndedCount === 1 &&
    lastRequestBody.messages.length === 2 &&
    lastRequestBody.messages[0].role === "system" &&
    lastRequestBody.messages[1].role === "user" &&
    lastRequestBody.messages[1].content === "打个招呼" &&
    lastRequestBody.model === "deepseek-v4-flash",
    JSON.stringify(inners21.map((x) => x && x.case)));

  // T22: agent thinking → thinkingDelta
  sseScript = [{ delta: { reasoning_content: "想一下" } }, { delta: { content: "答案" } }];
  r = await wrapped.stream(svcAgent, mAgentRun, null, null, {}, oneMsg(mkAgentReq("conv-t22", "问")));
  const thinkInners = (await collect(r.message)).map(agentInner);
  T("T22 agent thinking→thinkingDelta",
    thinkInners[1] && thinkInners[1].case === "thinkingDelta" && thinkInners[1].value.text === "想一下" &&
    thinkInners[2] && thinkInners[2].case === "textDelta" && thinkInners[2].value.text === "答案",
    JSON.stringify(thinkInners.map((x) => x && x.case)));

  // T23: agent 多轮记忆 — 同 conversationId 第二轮携带历史(含 system 规则)
  sseScript = [{ delta: { content: "二答" } }];
  r = await wrapped.stream(svcAgent, mAgentRun, null, null, {}, oneMsg(mkAgentReq("conv-t21", "第二问", {
    customSystemPrompt: "你是测试助手",
    requestContext: new AgentRequestContextT({ rules: [new AgentRuleT({ content: "规则甲" })] })
  })));
  await collect(r.message);
  const histMsgs = lastRequestBody.messages;
  T("T23 agent多轮记忆+system组装",
    histMsgs.length === 4 &&
    histMsgs[0].role === "system" && histMsgs[0].content.includes("你是测试助手") && histMsgs[0].content.includes("规则甲") &&
    histMsgs[1].role === "user" && histMsgs[1].content === "打个招呼" &&
    histMsgs[2].role === "assistant" && histMsgs[2].content === "你好" &&
    histMsgs[3].role === "user" && histMsgs[3].content === "第二问",
    JSON.stringify(histMsgs.map((m) => m.role + ":" + m.content)));

  // T24: agent 空回复兜底 — 占位 textDelta + turnEnded 仍恰好一次
  sseScript = [];
  r = await wrapped.stream(svcAgent, mAgentRun, null, null, {}, oneMsg(mkAgentReq("conv-t24", "空")));
  const emptyInners = (await collect(r.message)).map(agentInner);
  const emptyText = emptyInners.filter((x) => x && x.case === "textDelta").map((x) => x.value.text).join("");
  const emptyTurns = emptyInners.filter((x) => x && x.case === "turnEnded").length;
  T("T24 agent空回复兜底(turnEnded单次)",
    emptyText === "(model returned empty response)" && emptyTurns === 1,
    JSON.stringify(emptyInners.map((x) => x && x.case)));

  // T25: agent 工具调用循环 — 模型发 read_file → toolCallStarted/Completed →
  //      客户端回传 ExecClientMessage 结果 → 第二轮上游含 role:tool → 最终文本
  sseQueue = [
    [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/a.txt\"}" } }] } }],
    [{ delta: { content: "文件内容是X" } }]
  ];
  const reqBodiesBefore = requestBodies.length;
  r = await wrapped.stream(svcAgent, mAgentRun, null, null, {}, (async function* () {
    yield mkAgentReq("conv-t25", "读一下src/a.txt");
    await new Promise((rs) => setTimeout(rs, 300)); // 等 runtime 进入等待窗口
    yield new AgentClientMsgT({
      message: { case: "execClientMessage", value: new ExecClientMessageT({
        id: 1, execId: "call_1",
        message: { case: "readResult", value: new ReadFileResultT({ content: "FILE-CONTENT-X" }) }
      }) }
    });
  })());
  const toolInners = (await collect(r.message)).map(agentInner);
  const started25 = toolInners.find((x) => x && x.case === "toolCallStarted");
  const completed25 = toolInners.find((x) => x && x.case === "toolCallCompleted");
  const text25 = toolInners.filter((x) => x && x.case === "textDelta").map((x) => x.value.text).join("");
  const turns25 = toolInners.filter((x) => x && x.case === "turnEnded").length;
  const body1 = requestBodies[reqBodiesBefore] || {};
  const body2 = requestBodies[reqBodiesBefore + 1] || {};
  const toolMsg = body2.messages && body2.messages.find((m) => m.role === "tool");
  const asstMsg = body2.messages && body2.messages.find((m) => m.role === "assistant" && m.tool_calls);
  T("T25 agent工具调用循环(Started/Exec指令/结果回传/二轮)",
    !!started25 && started25.value.callId === "call_1" &&
    started25.value.toolCall.tool.case === "readToolCall" &&
    started25.value.toolCall.tool.value.args.path === "src/a.txt" &&
    !!completed25 && completed25.value.callId === "call_1" &&
    text25 === "文件内容是X" && turns25 === 1 &&
    Array.isArray(body1.tools) && body1.tools.length === 3 &&
    !!asstMsg && asstMsg.tool_calls[0].function.name === "read_file" &&
    !!toolMsg && toolMsg.tool_call_id === "call_1" && toolMsg.content.includes("FILE-CONTENT-X"),
    JSON.stringify(toolInners.map((x) => x && x.case)));

  // T26: agent 工具超时降级 — 客户端不回传结果 → 注入超时占位文本, 流程不中断
  const wTO = new Function(runtimeSrc.replace(JSON.stringify(cfg), JSON.stringify({ ...cfg, agentToolTimeoutMs: 250 })) + "\n;return globalThis.__CURSOR_CM__.wrap;")()(origTransport);
  sseQueue = [
    [{ delta: { tool_calls: [{ index: 0, id: "call_t", type: "function", function: { name: "read_file", arguments: "{\"path\":\"x\"}" } }] } }],
    [{ delta: { content: "降级完成" } }]
  ];
  const t0 = Date.now();
  r = await wTO.stream(svcAgent, mAgentRun, null, null, {}, oneMsg(mkAgentReq("conv-t26", "读x")));
  const toInners = (await collect(r.message)).map(agentInner);
  const toText = toInners.filter((x) => x && x.case === "textDelta").map((x) => x.value.text).join("");
  const toToolMsg = lastRequestBody.messages.find((m) => m.role === "tool");
  T("T26 agent工具超时降级(不中断)",
    toText === "降级完成" &&
    !!toToolMsg && /timed out/.test(toToolMsg.content) &&
    (Date.now() - t0) >= 200 && (Date.now() - t0) < 5000,
    JSON.stringify(toInners.map((x) => x && x.case)));

  // T27: requestContext 全量注入 — env/rules/仓库/目录树进入系统提示词
  sseScript = [{ delta: { content: "ok" } }];
  r = await wrapped.stream(svcAgent, mAgentRun, null, null, {}, oneMsg(mkAgentReq("conv-t27", "项目是什么结构", {
    requestContext: new AgentRequestContextT({
      env: new AgentEnvT({ osVersion: "Windows 11 Pro", shell: "powershell.exe", timeZone: "Asia/Shanghai", projectFolder: "D:/demo", workspacePaths: ["D:/demo"] }),
      rules: [new AgentRuleT({ fullPath: "D:/demo/.cursor/rules/core.mdc", content: "永远使用 TypeScript" })],
      repositoryInfo: [new AgentRepoInfoT({ repoName: "demo-app", repoOwner: "demo-owner", remoteUrls: ["https://github.com/demo-owner/demo-app"], relativeWorkspacePath: "." })],
      projectLayouts: [new AgentLayoutNodeT({ absPath: "D:/demo/cursor", numFiles: 3, childrenFiles: [new AgentLayoutFileT({ absPath: "D:/demo/cursor/main.ts" })] })]
    })
  })));
  await collect(r.message);
  const sys27 = lastRequestBody.messages[0];
  T("T27 requestContext全量注入系统提示词",
    sys27.role === "system" &&
    sys27.content.includes("OS: Windows 11 Pro") &&
    sys27.content.includes("Shell: powershell.exe") &&
    sys27.content.includes("Project folder: D:/demo") &&
    sys27.content.includes("Project rules") && sys27.content.includes("永远使用 TypeScript") && sys27.content.includes("core.mdc") &&
    sys27.content.includes("demo-owner/demo-app") &&
    sys27.content.includes("cursor/") && sys27.content.includes("main.ts"),
    sys27.content.slice(0, 300));

  // T28: 嵌套 requestContext (3.16.17 实证: 位于 action.userMessageAction 层, 顶层不填充)
  //     - env(含 terminalsFolder) 流入系统提示词; MCP 工具默认不带 schema;
  //     - 显式声明本会话仅 read_file/grep_search/list_dir 可调用;
  //     - stats.agentDebug.rcFrom 诊断为 "userMessageAction"
  sseScript = [{ delta: { content: "ok" } }];
  r = await wrapped.stream(svcAgent, mAgentRun, null, null, {}, oneMsg(new AgentClientMsgT({
    message: { case: "runRequest", value: {
      conversationId: "conv-t28",
      action: new AgentActionT({
        action: { case: "userMessageAction", value: new AgentUserMessageActionT({
          userMessage: new AgentUserMessageT({ text: "hi" }),
          requestContext: new AgentRequestContextT({
            env: new AgentEnvT({ osVersion: "win32 10.0.28000", shell: "powershell", timeZone: "Asia/Shanghai", projectFolder: "C:/demo", terminalsFolder: "C:/demo/terminals" }),
            tools: [new AgentToolT({ name: "cursor-ide-browser-browser_navigate", providerIdentifier: "cursor-ide-browser", toolName: "browser_navigate", description: "Navigate to URL", inputSchemaJson: "{\"type\":\"object\"}" })],
            mcpInstructions: [new AgentMcpInstructionT({ serverName: "cursor-ide-browser", instructions: "Use browser tools carefully." })]
          })
        }) }
      })
    } }
  })));
  await collect(r.message);
  const sys28 = lastRequestBody.messages[0];
  T("T28 嵌套requestContext(uma层)+工具不可调用声明",
    sys28.role === "system" &&
    sys28.content.includes("OS: win32 10.0.28000") &&
    sys28.content.includes("Shell: powershell") &&
    sys28.content.includes("Terminals folder: C:/demo/terminals") &&
    sys28.content.includes("cursor-ide-browser/browser_navigate") &&
    sys28.content.includes("Use browser tools carefully.") &&
    !sys28.content.includes("schema:") &&
    sys28.content.includes("read_file, grep_search, list_dir") &&
    sys28.content.includes("NOT callable here") &&
    cm.stats.agentDebug && cm.stats.agentDebug.rcFrom === "userMessageAction" &&
    cm.stats.agentDebug.sysLen > 269,
    JSON.stringify(cm.stats.agentDebug));
}
