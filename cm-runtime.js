/* ============================================================
 * Cursor Custom Models Runtime v1.6.1
 * 由 patch.ps1 注入到三个文件末尾（同一份代码，各自进程内独立运行）:
 *   workbench.desktop.main.js / workbench.glass.main.js (渲染进程)
 *   extensionHostProcess.js (扩展主机 - HTTP 真正终止点)
 * 拦截 ConnectRPC 传输层，将 Chat/CmdK/Agents 请求转发到
 * 用户配置的 OpenAI 兼容 API（DeepSeek / GLM 等）
 *
 * v1.6.1: 系统提示词纯透传 -- 只有模型走自定义, 不添加任何自写文案:
 *         删除自造角色提示词与工具可调用 Note 声明, 移除行为性标题后缀,
 *         系统消息仅含 Cursor 客户端收集的原文数据(env/.cursorrules/
 *         仓库/目录树/MCP 指令) + 请求内 customSystemPrompt 原文;
 *         新增 agentSystemPrompt 配置(默认空)供用户自行注入基础提示词
 * v1.6.0: 打通全部工具通道 -- agent.v1(Agents 界面)扩展为 8 内置工具
 *         (read_file/grep_search/list_dir/write_file/run_terminal_cmd/
 *          web_fetch/delete_file/read_lints) + MCP 动态工具(按
 *         requestContext.tools 注册 schema, 经 mcpArgs map<string,Value>
 *         下发, 客户端本地执行); Chat 界面(BiDi 通道)新增 Cursor 原生
 *         UI 级工具循环 client_side_tool_v2_call(READ_FILE_V2/
 *         RIPGREP_SEARCH/LIST_DIR_V2/GLOB_FILE_SEARCH/DELETE_FILE/
 *         RUN_TERMINAL_COMMAND_V2/WEB_FETCH/CALL_MCP_TOOL), 结果经
 *         clientSideToolV2Result 回传 role:"tool" 多轮闭环;
 *         系统提示词动态声明可调用工具(移除 "NOT callable" 限制)
 * v1.5.1: 修复 requestContext 读取位置 -- 3.16.17 实测其嵌在
 *         action.userMessageAction.requestContext(非顶层 runRequest.requestContext),
 *         双位置兼容读取, 环境上下文真实流入系统提示词;
 *         MCP 工具 schema 默认不注入(mcpToolSchemas 可开), 并显式声明
 *         本会话仅 read_file/grep_search/list_dir 可调用
 * v1.5.0: "经过模型选择器、不经服务端" -- 本地重组装 Cursor Agent 能力:
 *         requestContext 全量注入系统提示词(env/rules/仓库/目录树/MCP);
 *         Agent 工具调用循环(OpenAI function calling ↔ agent.v1
 *         toolCallStarted/Completed + ExecClientMessage 结果回传),
 *         模型可真实读取文件/搜索代码库, 由 Cursor 客户端本地执行
 * v1.3.3: agent 空回复兜底与 turnEnded 合并为单次发送；
 *         会话历史 Map 增加会话数上限(64)，防长期运行内存增长
 * v1.3.2: 扩展主机注入支持(无竞态惰性 Proxy)；usage 门禁拦截；
 *         agent.v1.AgentService/Run 协议(Cursor Agents 界面)完整支持
 * v1.3.1: CDP 可观测性(回复预览日志/stats 计数)
 * v1.2: 拦截目标改用真正携带内容的通道(StreamUnifiedChatWithToolsIdempotent)，
 *       移除 SSE/Poll 轮询通道(其请求 BidiRequestId 仅含 request_id，无对话内容)；
 *       请求解包改为递归 unwrap(clientChunk → streamUnifiedChatRequest 两层嵌套)
 * v1.1: 修复 CmdK/Agent 响应被 oneof 包装导致静默丢弃的问题；
 *       基于 protobuf-es v2 类型内省(fields.byMember)自动构造嵌套消息；
 *       CmdK 正确读取 contextItems(cmdKQuery/cmdKSelection/...) 并输出编辑协议
 * ============================================================ */
;(function () {
  "use strict";
  var CFG = __CM_CONFIG_PLACEHOLDER__;
  var g = globalThis;

  function looksUnconfigured(c) {
    if (!c) return true;
    if (!c.enabled) return true;
    if (!c.baseUrl) return true;
    if (!c.apiKey) return true;
    var k = String(c.apiKey);
    if (k.indexOf("your-") >= 0) return true; // 占位符未替换
    return false;
  }
  if (looksUnconfigured(CFG)) {
    g.__CURSOR_CM__ = { active: false, reason: "disabled-or-unconfigured", wrap: function (t) { return t; } };
    return;
  }

  var TAG = "[CustomModels]";
  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(TAG);
      console.log.apply(console, args);
    } catch (e) { /* noop */ }
  }
  function err() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(TAG);
      console.error.apply(console, args);
    } catch (e) { /* noop */ }
  }

  /* ---------- 拦截目标 ---------- */
  var TARGETS = {};
  (CFG.interceptMethods || []).forEach(function (m) { TARGETS[m] = 1; });
  function isTarget(service, method) {
    return Object.prototype.hasOwnProperty.call(TARGETS, service.typeName + "/" + method.name);
  }

  /* ---------- Usage 门禁拦截 ----------
   * 免费额度耗尽时 DashboardService/GetUsageLimitStatusAndActiveGrants 返回
   * HARD_BLOCK 状态(resetAtMs), 客户端在发送前直接锁死 composer 并显示
   * "You're paused until your usage resets" — 请求根本不会进入聊天拦截通道。
   * 这里返回空响应(usage_limit_policy_status 缺省)解除门禁。
   * 由 config.blockUsageGate 控制(默认开启)。 */
  var GATE_UNARYS = {
    "aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants": 1,
    "aiserver.v1.DashboardService/GetUsageLimitPolicyStatus": 1
  };
  function isUsageGate(service, method) {
    if (CFG.blockUsageGate === false) return false;
    return Object.prototype.hasOwnProperty.call(GATE_UNARYS, service.typeName + "/" + method.name);
  }
  function handleGateUnary(service, method) {
    var key = service.typeName + "/" + method.name;
    log("usage-gate bypass:", key);
    return Promise.resolve({
      stream: false,
      service: service,
      method: method,
      header: new Headers(),
      trailer: new Headers(),
      message: new method.O({}) // 空响应: isInSlowPool 缺省 false, 无 resetAtMs
    });
  }

  /* ============================================================
   * protobuf-es v2 类型内省
   * 生成的消息类: static typeName / static fields(查找表, 有 byMember())
   * FieldInfo: {no,name,localName,kind:"scalar"|"enum"|"map"|"message",T,repeated,opt,oneof}
   * OneofInfo: {localName, fields[], findField(localName)}
   * new MsgT(partial) 会递归构造嵌套普通对象(oneof 用 {case,value})
   * ============================================================ */
  function membersOf(MsgT) {
    try {
      var fl = MsgT && MsgT.fields;
      if (fl && typeof fl.byMember === "function") return fl.byMember() || [];
    } catch (e) { /* noop */ }
    return [];
  }
  // 在消息类型上按 localName 查字段（含 oneof 内部成员）
  function findFieldDeep(MsgT, localName) {
    var ms = membersOf(MsgT);
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (m.localName === localName) return m;
      if (m.kind === "oneof" && typeof m.findField === "function") {
        var f = m.findField(localName);
        if (f) return f;
      }
    }
    return null;
  }
  // 把 "设置字段值" 转为构造 partial（oneof 成员必须通过组设置）
  function setField(partial, field, value) {
    if (field.oneof && field.oneof.localName) {
      partial[field.oneof.localName] = { case: field.localName, value: value };
    } else {
      partial[field.localName] = value;
    }
    return partial;
  }

  /* ---------- 响应发射器解析（按类型缓存） ---------- */
  var emitterCache = new Map();
  // 返回 null 或 {kind:"direct"} / {kind:"wrap", field, sub}
  function resolveEmitter(RespT, depth) {
    if (!RespT || depth > 4) return null;
    if (emitterCache.has(RespT)) return emitterCache.get(RespT);
    emitterCache.set(RespT, null); // 防循环引用
    var result = null;
    // 1) 直接 text 字段
    var tf = findFieldDeep(RespT, "text");
    if (tf && tf.kind === "scalar") {
      result = { kind: "direct" };
    } else {
      // 2) 优先路径
      var prefer = ["streamUnifiedChatResponse", "realResponse", "serverChunk", "response", "chat", "editStream"];
      for (var pi = 0; pi < prefer.length && !result; pi++) {
        var pf = findFieldDeep(RespT, prefer[pi]);
        if (pf && pf.kind === "message" && pf.T) {
          var sub = resolveEmitter(pf.T, depth + 1);
          if (sub) result = { kind: "wrap", field: pf, sub: sub };
        }
      }
      // 3) 任意 message 字段
      var ms = membersOf(RespT);
      for (var i = 0; i < ms.length && !result; i++) {
        var m = ms[i];
        if (m.kind === "message" && m.T) {
          var sub2 = resolveEmitter(m.T, depth + 1);
          if (sub2) result = { kind: "wrap", field: m, sub: sub2 };
        } else if (m.kind === "oneof" && m.fields) {
          for (var j = 0; j < m.fields.length && !result; j++) {
            var of = m.fields[j];
            if (of.kind === "message" && of.T) {
              var sub3 = resolveEmitter(of.T, depth + 1);
              if (sub3) result = { kind: "wrap", field: of, sub: sub3 };
            }
          }
        }
      }
    }
    emitterCache.set(RespT, result);
    return result;
  }

  // 生成 "文本块" / "思维块" 的响应消息（text/thinking 在 emitter 链最内层类型上）
  function makeRespMsg(emitter, RespT, textChunk, thinkingChunk) {
    var leafT = leafTypeOf(emitter, RespT);
    function buildDeep(em, chunk, isThinking) {
      if (em.kind === "direct") {
        var p = {};
        if (isThinking) {
          var th = findFieldDeep(leafT, "thinking");
          if (th && th.kind === "message") return setField(p, th, { text: chunk });
          return null;
        }
        return setField(p, findFieldDeep(leafT, "text"), chunk);
      }
      var inner = buildDeep(em.sub, chunk, isThinking);
      if (inner === null) return null;
      var p2 = {};
      return setField(p2, em.field, inner);
    }
    var partial = buildDeep(emitter, textChunk || thinkingChunk, !!thinkingChunk);
    if (partial === null) return null;
    return new RespT(partial);
  }
  function leafTypeOf(emitter, RespT) {
    var em = emitter, T = RespT;
    while (em && em.kind === "wrap") { T = em.field.T; em = em.sub; }
    return T;
  }

  /* ---------- streamStart 预发（若响应类型有该字段） ---------- */
  function maybeStreamStart(RespT) {
    var f = findFieldDeep(RespT, "streamStart");
    if (f && f.kind === "message") {
      var p = {};
      setField(p, f, {});
      try { return new RespT(p); } catch (e) { return null; }
    }
    return null;
  }

  /* ============================================================
   * 请求 -> OpenAI 消息
   * ============================================================ */
  // ConversationMessage: text(1) type(2: HUMAN=1 AI=2) attachedCodeChunks(3) toolResults(18)
  function unifiedToMessages(req) {
    var out = [];
    var conv = (req && req.conversation) || [];
    for (var i = 0; i < conv.length; i++) {
      var m = conv[i];
      if (!m) continue;
      var role = (m.type === 2) ? "assistant" : "user";
      var parts = [];
      if (m.text) parts.push(String(m.text));
      var chunks = m.attachedCodeChunks || [];
      for (var c = 0; c < chunks.length; c++) {
        var ch = chunks[c];
        if (ch && ch.lines && ch.lines.length) {
          parts.push("\n[" + (ch.relativeWorkspacePath || "attached-file") + "]\n" + ch.lines.join("\n"));
        }
      }
      var trs = m.toolResults || [];
      for (var t = 0; t < trs.length; t++) {
        var tr = trs[t];
        var txt = "";
        try {
          txt = tr && (tr.text || (tr.result && tr.result.text) || "");
          if (!txt && tr && tr.toJson) txt = JSON.stringify(tr.toJson());
        } catch (e) { txt = ""; }
        if (txt) parts.push("\n[tool result]\n" + String(txt));
      }
      var text = parts.join("\n").trim();
      if (text) out.push({ role: role, content: text });
    }
    if (!out.length) out.push({ role: "user", content: "(empty request)" });
    return out;
  }

  // StreamCmdKRequest: contextItems(1, PotentiallyCachedContextItem) cmdKOptions(2) legacyContext(5)
  // ContextItem.item oneof: cmdKQuery(6){query} cmdKSelection(4){lines[],startLineNumber}
  //                         cmdKImmediateContext(5){relativeWorkspacePath,lines[{line,lineNumber}]}
  //                         fileChunk(2){relativeWorkspacePath,chunkContents,startLineNumber}
  function cmdkToMessages(req) {
    var query = "";
    var sel = null; // {lines:[], startLineNumber:n}
    var ctxParts = [];
    var items = (req && req.contextItems) || [];
    for (var i = 0; i < items.length; i++) {
      var pc = items[i];
      var ci = pc && pc.contextItem;
      if (!ci) continue;
      var it = ci.item;
      if (!it || !it.case) continue;
      var v = it.value || {};
      switch (it.case) {
        case "cmdKQuery":
          if (v.query) query = String(v.query);
          break;
        case "cmdKSelection":
          if (v.lines && v.lines.length) sel = { lines: v.lines, startLineNumber: v.startLineNumber || 1 };
          break;
        case "cmdKImmediateContext":
          if (v.lines && v.lines.length) {
            var lines = [];
            for (var L = 0; L < v.lines.length; L++) lines.push(v.lines[L].line || "");
            ctxParts.push("[file: " + (v.relativeWorkspacePath || "current") + " lines " +
              (v.lines[0].lineNumber || "?") + "-" + (v.lines[v.lines.length - 1].lineNumber || "?") + "]\n" + lines.join("\n"));
          }
          break;
        case "fileChunk":
          if (v.chunkContents) {
            ctxParts.push("[file: " + (v.relativeWorkspacePath || "context") + " from line " + (v.startLineNumber || 1) + "]\n" + v.chunkContents);
          }
          break;
      }
    }
    // legacyContext 兜底（旧路径组装的完整上下文字符串）
    if (!query) {
      var lc = req && req.legacyContext;
      var ect = lc && lc.explicitContext && lc.explicitContext.context;
      if (ect) query = String(ect).slice(0, 4000);
    }
    var selBlock = "";
    if (sel) {
      selBlock = "\n\nSelected code (lines " + sel.startLineNumber + "-" + (sel.startLineNumber + sel.lines.length - 1) + "):\n" + sel.lines.join("\n");
    }
    var ctxBlock = ctxParts.length ? "\n\n" + ctxParts.join("\n\n").slice(0, 12000) : "";
    var instruction = sel
      ? "You are a code editing assistant in an IDE. Replace the selected code according to the instruction. Output ONLY the replacement code, no markdown fences, no explanation."
      : "You are an assistant in an IDE. Answer the user's instruction.";
    var content = instruction + "\n\nInstruction: " + (query || "(no instruction)") + selBlock + ctxBlock;
    return { messages: [{ role: "user", content: content }], sel: sel };
  }

  // 递归解包请求包装层:
  //   Idempotent(C0s): {request:{case:"clientChunk", value: zEi}}
  //   zEi(WithTools):  {request:{case:"streamUnifiedChatRequest", value: dwe}}
  // 返回最内层 StreamUnifiedChatRequest，或 null(如 abort/close/toolResult 包装)
  function unwrapChatRequest(msg, depth) {
    var cur = msg;
    var d = depth || 0;
    while (cur && d < 6) {
      if (cur.conversation || cur.modelDetails || cur.currentFile) return cur;
      var r = cur.request;
      if (!r || !r.case || !r.value) return null;
      if (r.case === "clientChunk" || r.case === "streamUnifiedChatRequest") {
        cur = r.value; d++; continue;
      }
      return null; // abort/close/clientSideToolV2Result 等控制包
    }
    return null;
  }

  // BiDi 收集多条后合并所有 streamUnifiedChatRequest 的 conversation
  function bidiToRequest(collected) {
    var merged = { conversation: [], modelDetails: null };
    for (var i = 0; i < collected.length; i++) {
      var d = unwrapChatRequest(collected[i], 0);
      if (!d) continue;
      if (d.conversation) merged.conversation = merged.conversation.concat(d.conversation);
      if (d.modelDetails) merged.modelDetails = d.modelDetails;
      if (d.requestContext) merged.requestContext = d.requestContext;
    }
    return merged;
  }

  function resolveModel(req) {
    var mapping = CFG.modelMapping || {};
    var asked = "";
    try {
      asked = (req.modelDetails && req.modelDetails.modelName) ||
              (req.cmdKOptions && req.cmdKOptions.modelDetails && req.cmdKOptions.modelDetails.modelName) ||
              (req.requestedModel && req.requestedModel.modelId) || "";
    } catch (e) { asked = ""; }
    asked = String(asked || "");
    if (mapping[asked]) return mapping[asked];
    // 前缀匹配: deepseek-v4-flash → deepseek-* 等
    var keys = Object.keys(mapping);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k !== "*" && k.length > 2 && asked.toLowerCase().indexOf(k.toLowerCase()) === 0) return mapping[k];
    }
    return mapping["*"] || CFG.defaultModel || "deepseek-v4-flash";
  }

  /* ============================================================
   * agent.v1.AgentService/Run (Cursor Agents 界面协议)
   * 请求: AgentClientMessage.message oneof → runRequest
   *   runRequest.action.userMessageAction.userMessage.text (用户输入)
   *   runRequest.conversationId (多轮会话键)
   *   runRequest.requestContext 全量上下文(客户端收集, 原本由服务端组装进 prompt);
   *         位置兼容: 顶层 runRequest.requestContext 或嵌套于
   *         action.userMessageAction.requestContext(3.16.17 实测为后者):
   *     rules[]          .cursorrules 规则(fullPath/content/type)
   *     env              osVersion/workspacePaths/shell/timeZone/projectFolder
   *     repositoryInfo[] 仓库名/owner/remote URLs
   *     projectLayouts[] 目录树(递归 LsDirectoryTreeNode)
   *     mcpInstructions[] / tools[] (MCP 工具定义 name/description/inputSchemaJson)
   *   runRequest.requestedModel.modelId / modelDetails (模型 — 模型选择器结果)
   * 响应: AgentServerMessage.message oneof → interactionUpdate
   *   Interaction.message oneof → heartbeat / thinkingDelta / textDelta / turnEnded
   * ============================================================ */
  var agentHistory = new Map(); // conversationId → [{role, content}]
  var MAX_AGENT_CONVERSATIONS = 64; // 会话数上限: 防长期运行内存无限增长(每会话内最多 40 条)
  // protobuf-es v2: oneof 在实例上以组属性存储: msg.<oneofName> = {case, value}
  function oneofCase(container, oneofName) {
    try {
      var g = container && container[oneofName];
      if (g && g.case) return g.case;
      // 兼容直接属性形态
      var keys = container ? Object.keys(container) : [];
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] !== oneofName && container[keys[i]] != null) return keys[i];
      }
    } catch (e) { /* noop */ }
    return "";
  }
  function oneofValue(container, oneofName, caseName) {
    try {
      var g = container && container[oneofName];
      if (g && g.case === caseName) return g.value;
      if (container && container[caseName] != null) return container[caseName];
    } catch (e) { /* noop */ }
    return null;
  }
  function agentRunToPlan(list) {
    var rr = null;
    for (var i = 0; i < list.length; i++) {
      var mo = list[i] && list[i].message;
      if (mo && mo.case === "runRequest" && mo.value) { rr = mo.value; break; }
    }
    if (!rr) return null;
    var act = rr.action || {};
    var aCase = oneofCase(act, "action");
    var uma = oneofValue(act, "action", "userMessageAction");
    var um = uma && uma.userMessage;
    var text = (um && um.text) ? String(um.text) : "";
    // requestContext 双位置兼容(3.16.17 实测 dump):
    //   新: action.userMessageAction.requestContext (env/tools/mcpInstructions...)
    //   旧: runRequest.requestContext (顶层)
    var rc = null, rcFrom = "none";
    if (rr.requestContext) { rc = rr.requestContext; rcFrom = "runRequest"; }
    else if (uma && uma.requestContext) { rc = uma.requestContext; rcFrom = "userMessageAction"; }
    return {
      text: text,
      convId: rr.conversationId ? String(rr.conversationId) : "",
      customSystemPrompt: rr.customSystemPrompt ? String(rr.customSystemPrompt) : "",
      requestContext: rc,
      rcFrom: rcFrom,
      system: "", // 由 buildAgentSystemPrompt 组装
      modelReq: { modelDetails: rr.modelDetails || null, requestedModel: rr.requestedModel || null },
      actionCase: aCase
    };
  }

  /* ---------- 本地重组装: Cursor 风格系统提示词(替代服务端 prompt 组装) ---------- */
  // 目录树递归展开(LsDirectoryTreeNode: absPath/childrenDirs/childrenFiles/numFiles)
  function layoutLines(nodes, depth, maxDepth, out, maxLines) {
    if (!nodes || !nodes.length || depth > maxDepth || out.length >= maxLines) return;
    for (var i = 0; i < nodes.length && out.length < maxLines; i++) {
      var n = nodes[i];
      if (!n || !n.absPath) continue;
      var base = String(n.absPath).replace(/^.*[\\\/]/, "");
      var meta = (n.numFiles != null ? " (" + n.numFiles + " files)" : "");
      out.push(new Array(depth + 1).join("  ") + base + "/" + meta);
      var dirs = n.childrenDirs || [];
      var files = n.childrenFiles || [];
      for (var f = 0; f < files.length && out.length < maxLines; f++) {
        var fe = files[f];
        var fb = fe ? String(fe.absPath || fe.name || fe.relativeWorkspacePath || "").replace(/^.*[\\\/]/, "") : "";
        if (fb) out.push(new Array(depth + 2).join("  ") + fb);
      }
      layoutLines(dirs, depth + 1, maxDepth, out, maxLines);
    }
  }
  function buildAgentSystemPrompt(plan) {
    var ctx = CFG.agentContext || {};
    var parts = [];
    var rc = plan.requestContext;
    // 纯透传(v1.6.1): 不注入任何自写角色提示词, 系统消息只由
    // Cursor 收集的原文数据 + 请求内 customSystemPrompt 组成;
    // agentSystemPrompt 配置(默认空)是唯一可选的自定义入口
    if (CFG.agentSystemPrompt) parts.push(String(CFG.agentSystemPrompt));
    // 环境信息(env)
    if (ctx.env !== false && rc && rc.env) {
      var e = rc.env;
      var el = [];
      if (e.osVersion) el.push("OS: " + e.osVersion);
      if (e.shell) el.push("Shell: " + e.shell);
      if (e.timeZone) el.push("Timezone: " + e.timeZone);
      if (e.projectFolder) el.push("Project folder: " + e.projectFolder);
      if (e.terminalsFolder) el.push("Terminals folder: " + e.terminalsFolder);
      var ws = e.workspacePaths || [];
      if (ws.length) el.push("Workspace roots: " + ws.join("; "));
      if (el.length) parts.push("# Environment\n" + el.join("\n"));
    }
    // 项目规则(rules: .cursorrules 等)
    if (ctx.rules !== false && rc && rc.rules && rc.rules.length) {
      var rl = [];
      for (var r = 0; r < rc.rules.length; r++) {
        var rule = rc.rules[r];
        if (rule && rule.content) {
          var tag = rule.fullPath ? " (from " + String(rule.fullPath).replace(/^.*[\\\/]/, "") + ")" : "";
          rl.push(String(rule.content) + tag);
        }
      }
      if (rl.length) parts.push("# Project rules\n" + rl.join("\n\n").slice(0, 20000));
    }
    // 仓库信息
    if (ctx.repo !== false && rc && rc.repositoryInfo && rc.repositoryInfo.length) {
      var repos = [];
      for (var q = 0; q < rc.repositoryInfo.length; q++) {
        var ri = rc.repositoryInfo[q];
        if (!ri) continue;
        var name = ri.repoName || ri.relativeWorkspacePath || "repo";
        var seg = String(name);
        if (ri.repoOwner) seg = ri.repoOwner + "/" + seg;
        var urls = ri.remoteUrls || [];
        if (urls.length) seg += " <" + String(urls[0]).slice(0, 100) + ">";
        repos.push(seg);
      }
      if (repos.length) parts.push("# Git repositories\n" + repos.join("\n"));
    }
    // 项目目录树
    if (ctx.layout !== false && rc && rc.projectLayouts && rc.projectLayouts.length) {
      var maxLines = ctx.layoutMaxLines || 160;
      var lines = [];
      layoutLines(rc.projectLayouts, 0, ctx.layoutMaxDepth || 4, lines, maxLines);
      if (lines.length) {
        var tree = lines.join("\n");
        if (lines.length >= maxLines) tree += "\n... (truncated)";
        parts.push("# Project structure\n" + tree);
      }
    }
    // MCP 服务器指令与工具定义
    if (ctx.mcp !== false && rc) {
      var mi = rc.mcpInstructions || [];
      var mcpParts = [];
      for (var m2 = 0; m2 < mi.length; m2++) {
        if (mi[m2] && (mi[m2].content || mi[m2].instructions)) mcpParts.push(String(mi[m2].content || mi[m2].instructions));
      }
      // inputSchemaJson 门控(默认关闭): 20+ Cursor 内置浏览器工具 schema 会撑爆提示词,
      // 且这些工具在本会话无执行通道, 列出 schema 反而诱导模型调用不可执行工具
      var withSchemas = ctx.mcpToolSchemas === true;
      var tl = rc.tools || [];
      var toolDescs = [];
      for (var t2 = 0; t2 < tl.length && toolDescs.length < 60; t2++) {
        var td = tl[t2];
        if (!td || !td.name) continue;
        var d = "- " + td.providerIdentifier + "/" + td.toolName + ": " + String(td.description || "").slice(0, 200);
        if (withSchemas && td.inputSchemaJson) d += "\n  schema: " + String(td.inputSchemaJson).slice(0, 800);
        toolDescs.push(d);
      }
      if (mcpParts.length || toolDescs.length) {
        var seg2 = "# MCP integrations";
        if (mcpParts.length) seg2 += "\n" + mcpParts.join("\n").slice(0, 8000);
        if (toolDescs.length) seg2 += "\n# MCP tools\n" + toolDescs.join("\n");
        parts.push(seg2);
      }
    }
    // 请求内 customSystemPrompt 原文透传(不加自写标题)
    if (plan.customSystemPrompt) parts.push(String(plan.customSystemPrompt));
    return parts.join("\n\n").slice(0, 60000);
  }

  /* ============================================================
   * Agent 工具调用循环 (v1.5.0)
   * 原理: Cursor Agents 的工具(read/grep/glob/ls...)由客户端本地执行,
   * 服务端只负责让模型发起调用。本地编排:
   *   1. 上游 OpenAI 请求携带 function tools
   *   2. 模型返回 tool_calls → 转成 agent.v1 toolCallStarted/Completed
   *   3. Cursor 客户端收到后本地执行, 经 BiDi 反向流回传 ExecClientMessage
   *   4. 结果序列化回 OpenAI role:"tool" 消息 → 下一轮上游调用
   *   5. 直到模型输出纯文本 → turnEnded
   * ============================================================ */
  var AGENT_TOOLS_ON = CFG.agentTools !== false;       // 默认开启
  var AGENT_TOOL_TIMEOUT = CFG.agentToolTimeoutMs || 30000;
  var AGENT_MAX_ROUNDS = CFG.agentMaxToolRounds || 8;
  // OpenAI 函数名 → agent.v1 映射(仅保留有独立 exec 通道的工具: glob/semantic 无 result 通道已移除)
  var AGENT_TOOL_MAP = {
    read_file:        { caseName: "readToolCall",       execCase: "readArgs",        argKeys: { path: "path", offset: "offset", limit: "limit" } },
    grep_search:      { caseName: "grepToolCall",       execCase: "grepArgs",        argKeys: { pattern: "pattern", path: "path", glob: "glob", outputMode: "output_mode", contextBefore: "context_before", contextAfter: "context_after" } },
    list_dir:         { caseName: "lsToolCall",         execCase: "lsArgs",          argKeys: { path: "path" } },
    write_file:       { caseName: "editToolCall",       execCase: "writeArgs",       argKeys: { path: "path", fileText: "content" }, uiArgKeys: { path: "path", streamContent: "content" } },
    run_terminal_cmd: { caseName: "shellToolCall",      execCase: "shellArgs",       argKeys: { command: "command", workingDirectory: "working_directory" } },
    web_fetch:        { caseName: "fetchToolCall",      execCase: "fetchArgs",       argKeys: { url: "url" } },
    delete_file:      { caseName: "deleteToolCall",     execCase: "deleteArgs",      argKeys: { path: "path" } },
    read_lints:       { caseName: "readLintsToolCall",  execCase: "diagnosticsArgs", argKeys: { path: "path" }, uiArgKeys: { paths: "path" } }
  };
  var AGENT_MCP_ENTRY = { caseName: "mcpToolCall", execCase: "mcpArgs" };
  // Cursor 3.16 requires this metadata before it will execute a shell command.
  function shellParsingResult(command) {
    var text = String(command == null ? "" : command).trim();
    var hasSubstitution = /(^|[^\\])(?:\$\(|`)/.test(text);
    var hasRedirects = /(^|[^\\])(?:\d*(?:>>?|<<?)|&>>?|\|&)/.test(text);
    var quoteCount = 0;
    for (var qi = 0; qi < text.length; qi++) {
      if (text.charAt(qi) === "\\") { qi++; continue; }
      if (text.charAt(qi) === "'" || text.charAt(qi) === '"') quoteCount ^= 1;
    }
    var unsupported = !text || quoteCount || hasSubstitution || hasRedirects || /(^|[^\\])(?:\n|\(|\)|\{|\})/.test(text);
    var executables = [];
    if (!unsupported) {
      var segments = text.split(/\s*(?:&&|\|\||;|\|)\s*/);
      for (var si = 0; si < segments.length; si++) {
        var segment = segments[si].trim();
        if (!segment) { unsupported = true; break; }
        var tokens = segment.match(/(?:[^\s"'\\]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) || [];
        if (!tokens.length) { unsupported = true; break; }
        function unquoteToken(token) {
          if (token.length >= 2 && ((token.charAt(0) === '"' && token.charAt(token.length - 1) === '"') || (token.charAt(0) === "'" && token.charAt(token.length - 1) === "'"))) return token.slice(1, -1);
          return token;
        }
        var args = [];
        for (var ti = 1; ti < tokens.length; ti++) args.push({ type: "word", value: unquoteToken(tokens[ti]) });
        executables.push({ name: unquoteToken(tokens[0]), args: args, fullText: segment });
      }
    }
    return { parsingFailed: !!unsupported, executableCommands: unsupported ? [] : executables, hasRedirects: hasRedirects, hasCommandSubstitution: hasSubstitution, redirects: [] };
  }
  function addShellParsingResult(ArgsT, argsPartial, command) {
    var f = ArgsT && findFieldDeep(ArgsT, "parsingResult");
    if (f && f.T) setField(argsPartial, f, new f.T(partialFor(f.T, shellParsingResult(command))));
  }
  function resolveAgentTool(name, mcpTools) {
    if (Object.prototype.hasOwnProperty.call(AGENT_TOOL_MAP, name)) return { entry: AGENT_TOOL_MAP[name], mcp: null };
    if (mcpTools && mcpTools.length) {
      for (var i = 0; i < mcpTools.length; i++) {
        var td = mcpTools[i];
        if (td && td.name === name) return { entry: AGENT_MCP_ENTRY, mcp: td };
      }
    }
    return null;
  }
  function wrapJsonValue(ValueT, v) {
    try {
      if (ValueT && typeof ValueT.wrap === "function") return ValueT.wrap(v);
      if (ValueT && typeof ValueT.fromJson === "function") return ValueT.fromJson(v);
    } catch (e) { /* fallthrough */ }
    return v;
  }
  function isWellKnownJsonT(T) {
    return !!(T && T.typeName && T.typeName.indexOf("google.protobuf.") === 0);
  }
  // 递归构造 protobuf partial: 按 T 的真实字段过滤/包装 JSON 值(well-known 类型用 wrap)
  function partialFor(T, obj) {
    var out = {};
    for (var k in obj) {
      var v = obj[k];
      if (v === undefined || v === null) continue;
      var f = findFieldDeep(T, k);
      if (!f) continue;
      if (f.kind === "map") {
        var mo = {};
        for (var mk in v) mo[mk] = (f.V && f.V.T) ? wrapJsonValue(f.V.T, v[mk]) : v[mk];
        setField(out, f, mo);
      } else if (f.kind === "message" && f.T) {
        if (f.repeated) {
          var arr = Array.isArray(v) ? v : [v];
          var wa = [];
          for (var ai = 0; ai < arr.length; ai++) {
            var item = arr[ai];
            wa.push(isWellKnownJsonT(f.T) ? wrapJsonValue(f.T, item) : new f.T(partialFor(f.T, item)));
          }
          setField(out, f, wa);
        } else if (isWellKnownJsonT(f.T)) {
          setField(out, f, wrapJsonValue(f.T, v));
        } else {
          setField(out, f, new f.T(partialFor(f.T, v)));
        }
      } else {
        if (f.repeated && !Array.isArray(v)) v = [v];
        setField(out, f, v);
      }
    }
    return out;
  }
  // MCP 工具调用 args partial(按 ArgsT 真实字段填充, args map 值走 Value.wrap)
  function buildMcpArgsPartial(ArgsT, callId, td, argsObj) {
    var p = {};
    if (findFieldDeep(ArgsT, "toolCallId")) p.toolCallId = callId;
    if (td.name && findFieldDeep(ArgsT, "name")) p.name = td.name;
    if (td.providerIdentifier && findFieldDeep(ArgsT, "providerIdentifier")) p.providerIdentifier = td.providerIdentifier;
    if (td.toolName && findFieldDeep(ArgsT, "toolName")) p.toolName = td.toolName;
    var f = findFieldDeep(ArgsT, "args");
    if (f && f.kind === "map" && f.V && f.V.T) {
      var mo = {};
      for (var k in argsObj) mo[k] = wrapJsonValue(f.V.T, argsObj[k]);
      p.args = mo;
    }
    return p;
  }
  // 解析 MCP inputSchemaJson -> OpenAI function parameters(异常兜底为开放 object)
  function mcpToolParamsSchema(td) {
    var raw = td.inputSchemaJson;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
    if (!raw || typeof raw !== "object") raw = {};
    var p = { type: "object" };
    if (raw.properties && typeof raw.properties === "object") p.properties = raw.properties;
    if (Array.isArray(raw.required)) p.required = raw.required;
    if (raw.additionalProperties !== undefined) p.additionalProperties = raw.additionalProperties;
    if (!p.properties) { p.properties = {}; p.additionalProperties = true; }
    return p;
  }
  function mcpToolSchemas(mcpTools, cap) {
    var out = [];
    if (!mcpTools || !mcpTools.length) return out;
    var max = cap || 40;
    for (var i = 0; i < mcpTools.length && out.length < max; i++) {
      var td = mcpTools[i];
      if (!td || !td.name) continue;
      out.push({ type: "function", function: { name: td.name, description: String(td.description || ("MCP tool " + td.name)).slice(0, 600), parameters: mcpToolParamsSchema(td) } });
    }
    return out;
  }
  function agentToolSchemas(mcpTools) {
    var defs = [
      { type: "function", function: { name: "read_file", description: "Read the contents of a file. Returns file content, optionally numbered lines.", parameters: { type: "object", properties: { path: { type: "string", description: "Absolute or workspace-relative file path" }, offset: { type: "integer", description: "Line number to start from (1-based, optional)" }, limit: { type: "integer", description: "Max number of lines to read (optional)" } }, required: ["path"] } } },
      { type: "function", function: { name: "grep_search", description: "Regex search across files in the workspace (ripgrep-powered). Use output_mode 'content' to see matching lines with line numbers, 'files_with_matches' to list files, 'count' for counts.", parameters: { type: "object", properties: { pattern: { type: "string", description: "Regular expression pattern" }, path: { type: "string", description: "File or directory to search in (optional, defaults to workspace)" }, glob: { type: "string", description: "Glob filter, e.g. '*.py' (optional)" }, output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output format (optional)" }, context_before: { type: "integer", description: "Lines of context before match (optional)" }, context_after: { type: "integer", description: "Lines of context after match (optional)" } }, required: ["pattern"] } } },
      { type: "function", function: { name: "list_dir", description: "List immediate files and subdirectories of a directory.", parameters: { type: "object", properties: { path: { type: "string", description: "Directory path" } }, required: ["path"] } } },
      { type: "function", function: { name: "write_file", description: "Create or overwrite a file with the given full content.", parameters: { type: "object", properties: { path: { type: "string", description: "File path to write" }, content: { type: "string", description: "Full file content to write" } }, required: ["path", "content"] } } },
      { type: "function", function: { name: "run_terminal_cmd", description: "Run a shell command in the workspace and return output. Use sparingly for build/test/git operations.", parameters: { type: "object", properties: { command: { type: "string", description: "Shell command to execute" }, working_directory: { type: "string", description: "Working directory (optional)" } }, required: ["command"] } } },
      { type: "function", function: { name: "web_fetch", description: "Fetch a URL and return the page content.", parameters: { type: "object", properties: { url: { type: "string", description: "URL to fetch" } }, required: ["url"] } } },
      { type: "function", function: { name: "delete_file", description: "Delete a file in the workspace.", parameters: { type: "object", properties: { path: { type: "string", description: "File path to delete" } }, required: ["path"] } } },
      { type: "function", function: { name: "read_lints", description: "Read lint/diagnostic errors for a file.", parameters: { type: "object", properties: { path: { type: "string", description: "File path to inspect" } }, required: ["path"] } } }
    ];
    return defs.concat(mcpToolSchemas(mcpTools));
  }

  /* ============================================================
   * Chat 界面工具通道 (v1.6.0): aiserver.v1 clientSideToolV2Call
   * StreamUnifiedChatWithTools(BiDi) 响应类型带 clientSideToolV2Call,
   * 客户端本地执行后经请求流回传 clientSideToolV2Result。
   * 编排: OpenAI tool_calls -> ClientSideToolV2Call(枚举 tool + params oneof)
   *   -> 客户端执行 -> clientSideToolV2Result -> role:"tool" 回填 -> 下一轮
   * ============================================================ */
  var CHAT_TOOL_MAP = {
    read_file:        { tool: "READ_FILE_V2",           paramsCase: "readFileV2Params",           map: { targetFile: "path", offset: "offset", limit: "limit" } },
    grep_search:      { tool: "RIPGREP_SEARCH",         paramsCase: "ripgrepSearchParams",
      build: function (a) { return { patternInfo: { pattern: String(a.pattern != null ? a.pattern : ""), isRegExp: a.is_reg_exp !== false, isCaseSensitive: !!a.is_case_sensitive } }; } },
    list_dir:         { tool: "LIST_DIR_V2",            paramsCase: "listDirV2Params",            map: { targetDirectory: "path" } },
    glob_search:      { tool: "GLOB_FILE_SEARCH",       paramsCase: "globFileSearchParams",        map: { targetDirectory: "path", globPattern: "pattern" } },
    delete_file:      { tool: "DELETE_FILE",            paramsCase: "deleteFileParams",           map: { relativeWorkspacePath: "path" } },
    run_terminal_cmd: { tool: "RUN_TERMINAL_COMMAND_V2", paramsCase: "runTerminalCommandV2Params",
      build: function (a) { return { command: a.command, cwd: a.working_directory, requireUserApproval: true }; } },
    web_fetch:        { tool: "WEB_FETCH",              paramsCase: "webFetchParams",             map: { url: "url" } }
  };
  var CHAT_MCP_CFG = { tool: "CALL_MCP_TOOL", paramsCase: "callMcpToolParams", mcp: true };
  // 枚举成员存在性校验(不同版本协议成员集可能不同), MCP 工具按 td.name 精确匹配
  function resolveChatTool(name, enumT, mcpTools) {
    var cfg = Object.prototype.hasOwnProperty.call(CHAT_TOOL_MAP, name) ? CHAT_TOOL_MAP[name] : null;
    if (cfg && enumT && enumT[cfg.tool] != null) return { cfg: cfg, mcp: null };
    if (enumT && enumT.CALL_MCP_TOOL != null && mcpTools && mcpTools.length) {
      for (var i = 0; i < mcpTools.length; i++) {
        var td = mcpTools[i];
        if (td && td.name === name) return { cfg: CHAT_MCP_CFG, mcp: td };
      }
    }
    return null;
  }
  function chatToolSchemas(enumT, mcpTools) {
    var defs = [
      { type: "function", function: { name: "read_file", description: "Read the contents of a file. Returns file content, optionally numbered lines.", parameters: { type: "object", properties: { path: { type: "string", description: "Absolute or workspace-relative file path" }, offset: { type: "integer", description: "Line number to start from (1-based, optional)" }, limit: { type: "integer", description: "Max number of lines to read (optional)" } }, required: ["path"] } } },
      { type: "function", function: { name: "grep_search", description: "Regex search across files in the workspace (ripgrep-powered). Use output_mode 'content' to see matching lines with line numbers, 'files_with_matches' to list files, 'count' for counts.", parameters: { type: "object", properties: { pattern: { type: "string", description: "Regular expression pattern" }, path: { type: "string", description: "File or directory to search in (optional, defaults to workspace)" }, glob: { type: "string", description: "Glob filter, e.g. '*.py' (optional)" }, output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output format (optional)" }, context_before: { type: "integer", description: "Lines of context before match (optional)" }, context_after: { type: "integer", description: "Lines of context after match (optional)" } }, required: ["pattern"] } } },
      { type: "function", function: { name: "list_dir", description: "List immediate files and subdirectories of a directory.", parameters: { type: "object", properties: { path: { type: "string", description: "Directory path" } }, required: ["path"] } } },
      { type: "function", function: { name: "glob_search", description: "Fast file pattern matching using glob patterns.", parameters: { type: "object", properties: { pattern: { type: "string", description: "Glob pattern, e.g. '**/*.py'" }, path: { type: "string", description: "Directory to search in (optional, defaults to workspace)" } }, required: ["pattern"] } } },
      { type: "function", function: { name: "delete_file", description: "Delete a file in the workspace.", parameters: { type: "object", properties: { path: { type: "string", description: "File path to delete" } }, required: ["path"] } } },
      { type: "function", function: { name: "run_terminal_cmd", description: "Run a shell command in the workspace and return output. Use sparingly for build/test/git operations.", parameters: { type: "object", properties: { command: { type: "string", description: "Shell command to execute" }, working_directory: { type: "string", description: "Working directory (optional)" } }, required: ["command"] } } },
      { type: "function", function: { name: "web_fetch", description: "Fetch a URL and return the page content.", parameters: { type: "object", properties: { url: { type: "string", description: "URL to fetch" } }, required: ["url"] } } }
    ];
    var out = [];
    for (var i = 0; i < defs.length; i++) {
      var cfg = CHAT_TOOL_MAP[defs[i].function.name];
      if (!enumT || (cfg && enumT[cfg.tool] != null)) out.push(defs[i]);
    }
    if (enumT && enumT.CALL_MCP_TOOL != null) out = out.concat(mcpToolSchemas(mcpTools));
    return out;
  }
  // OpenAI args -> ClientSideToolV2Call.params oneof 成员 partial(JSON 形态, 后续经 partialFor 包装)
  function chatParamsPartial(cfg, mcp, a) {
    if (cfg.mcp) {
      var p = {};
      if (mcp.providerIdentifier) p.server = mcp.providerIdentifier;
      if (mcp.toolName) p.toolName = mcp.toolName;
      p.toolArgs = a;
      return p;
    }
    if (typeof cfg.build === "function") return cfg.build(a);
    var p2 = {};
    for (var k in cfg.map) {
      var v = a[cfg.map[k]];
      if (v !== undefined && v !== null) p2[k] = v;
    }
    return p2;
  }
  function serializeToolResult(msg) {
    try { if (msg && msg.toJson) return JSON.stringify(msg.toJson()); } catch (e) { /* fallthrough */ }
    try { return JSON.stringify(msg); } catch (e2) { return String(msg); }
  }
  // 构造 toolCallStarted/Completed 更新消息(全类型内省, 不依赖压缩变量名)
  // ap: {interField, interType, outerType}; field: Started/Completed 字段描述符
  function buildAgentToolUpdate(ap, field, callId, resolved, argsObj, resultMsg) {
    try {
      if (!field || !field.T) return null;
      var entry = resolved && resolved.entry;
      if (!entry) return null;
      var updT = field.T;
      var tcF = findFieldDeep(updT, "toolCall");
      if (!tcF || !tcF.T) return null;
      var ToolCallT = tcF.T;
      var caseF = findFieldDeep(ToolCallT, entry.caseName);
      if (!caseF || !caseF.T) return null;
      var CallT = caseF.T;
      var argsF = findFieldDeep(CallT, "args");
      var argsT = argsF && argsF.T;
      var argsPartial = {};
      if (resolved.mcp && argsT) {
        argsPartial = buildMcpArgsPartial(argsT, callId, resolved.mcp, argsObj);
      } else {
        var argKeys = entry.uiArgKeys || entry.argKeys; // UI 展示层 args 字段名可不同于 exec 通道
        for (var k in argKeys) {
          var v = argsObj[argKeys[k]];
          if (v === undefined || v === null) continue;
          if (!argsT || findFieldDeep(argsT, k)) {
            var df = argsT && findFieldDeep(argsT, k);
            if (df && df.repeated && !Array.isArray(v)) v = [v];
            argsPartial[k] = v;
          }
        }
        if (entry.execCase === "shellArgs") addShellParsingResult(argsT, argsPartial, argsObj.command);
      }
      var callPartial = {};
      if (argsF) setField(callPartial, argsF, argsT ? new argsT(argsPartial) : argsPartial);
      if (resultMsg) {
        var resF = findFieldDeep(CallT, "result");
        if (resF) setField(callPartial, resF, resultMsg);
      }
      var tcPartial = {};
      setField(tcPartial, caseF, new CallT(callPartial));
      var updPartial = { callId: callId };
      setField(updPartial, tcF, new ToolCallT(tcPartial));
      var interPartial = {};
      setField(interPartial, field, new updT(updPartial));
      var outer = {};
      setField(outer, ap.interField, new ap.interType(interPartial));
      return new ap.outerType(outer);
    } catch (e) { err("toolCall update failed:", e && e.message); return null; }
  }
  // 构造 execServerMessage — 真正驱动客户端执行工具的指令通道(协议核心):
  // 客户端 exec 编排器只处理 execServerMessage(@26211965 源码实证),
  // toolCallStarted/Completed 仅是 UI 展示层。args 内 toolCallId 关联 call。
  function buildExecServerUpdate(RespT, seqId, callId, resolved, argsObj) {
    try {
      var entry = resolved && resolved.entry;
      if (!entry) return null;
      var fExec = findFieldDeep(RespT, "execServerMessage");
      if (!fExec || !fExec.T) return null;
      var ExecT = fExec.T;
      var caseF = findFieldDeep(ExecT, entry.execCase);
      if (!caseF || !caseF.T) return null;
      var ArgsT = caseF.T;
      var argsPartial = {};
      if (resolved.mcp) {
        argsPartial = buildMcpArgsPartial(ArgsT, callId, resolved.mcp, argsObj);
      } else {
        if (findFieldDeep(ArgsT, "toolCallId")) argsPartial.toolCallId = callId;
        for (var k in entry.argKeys) {
          var v = argsObj[entry.argKeys[k]];
          if (v === undefined || v === null) continue;
          if (findFieldDeep(ArgsT, k)) {
            var df = findFieldDeep(ArgsT, k);
            if (df.repeated && !Array.isArray(v)) v = [v];
            argsPartial[k] = v;
          }
        }
        if (entry.execCase === "shellArgs") addShellParsingResult(ArgsT, argsPartial, argsObj.command);
      }
      var execPartial = { id: seqId, execId: callId };
      setField(execPartial, caseF, new ArgsT(argsPartial));
      var outer = {};
      setField(outer, fExec, new ExecT(execPartial));
      return new RespT(outer);
    } catch (e) { err("execServer build failed:", e && e.message); return null; }
  }
  function agentBuildMessages(plan) {
    var out = [];
    if (plan.system) out.push({ role: "system", content: plan.system });
    var hist = plan.convId ? (agentHistory.get(plan.convId) || []) : [];
    for (var i = 0; i < hist.length; i++) out.push({ role: hist[i].role, content: hist[i].content });
    out.push({ role: "user", content: plan.text || "(empty message)" });
    return out;
  }
  function agentRemember(convId, userText, assistantText) {
    if (!convId) return;
    var h = agentHistory.get(convId) || [];
    h.push({ role: "user", content: userText });
    h.push({ role: "assistant", content: assistantText });
    while (h.length > 40) h.shift();
    // 新会话且已达上限: 淘汰最旧会话(Map 保持插入序)
    if (!agentHistory.has(convId) && agentHistory.size >= MAX_AGENT_CONVERSATIONS) {
      var oldest = agentHistory.keys().next();
      if (!oldest.done) agentHistory.delete(oldest.value);
    }
    agentHistory.set(convId, h);
  }

  /* ---------- OpenAI 兼容流式调用 ---------- */
  function callUpstream(messages, model, signal, tools) {
    var url = String(CFG.baseUrl).replace(/\/+$/, "") + "/chat/completions";
    var body = { model: model, messages: messages, stream: true };
    if (tools && tools.length) body.tools = tools;
    if (CFG.temperature != null) body.temperature = CFG.temperature;
    if (CFG.maxTokens != null) body.max_tokens = CFG.maxTokens;
    var headers = { "content-type": "application/json", "authorization": "Bearer " + CFG.apiKey };
    var extra = CFG.extraHeaders || {};
    Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
    return fetch(url, { method: "POST", signal: signal, headers: headers, body: JSON.stringify(body) });
  }

  // 解析 SSE，yield {type:"text"|"reasoning", text}
  function sseIterator(res) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    var done = false;
    return {
      next: function () {
        function parseLine() {
          while (true) {
            var idx = buf.indexOf("\n");
            if (idx < 0) return null;
            var line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (line.indexOf("data:") !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === "[DONE]") { done = true; return { value: undefined, done: true }; }
            var j = null;
            try { j = JSON.parse(payload); } catch (e) { continue; }
            var delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (!delta) continue;
            var reasoning = delta.reasoning_content || delta.reasoning;
            if (reasoning) return { value: { type: "reasoning", text: String(reasoning) }, done: false };
            if (delta.tool_calls && delta.tool_calls.length) return { value: { type: "toolCall", toolCalls: delta.tool_calls }, done: false };
            if (delta.content) return { value: { type: "text", text: String(delta.content) }, done: false };
          }
        }
        if (done) return Promise.resolve({ value: undefined, done: true });
        var r = parseLine();
        if (r) return Promise.resolve(r);
        var self = this;
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            var last = parseLine();
            return last || { value: undefined, done: true };
          }
          buf += decoder.decode(chunk.value, { stream: true });
          var r2 = parseLine();
          if (r2) return r2;
          return self.next();
        });
      },
      "return": function () {
        try { reader.cancel(); } catch (e) { /* noop */ }
        return Promise.resolve({ value: undefined, done: true });
      }
    };
  }

  /* ============================================================
   * 调试转储: agent.v1.AgentService/Run 协议结构探测
   * 由 config.debugDump 控制, 收集请求/响应消息结构到 __CURSOR_CM__.__dump
   * ============================================================ */
  var dumpStore = { requests: [], respTypeName: null, respFields: null, reqTypeName: null, reqFields: null };
  function dumpFields(MsgT, depth) {
    var out = [];
    var ms = [];
    try { ms = membersOf(MsgT) || []; } catch (e) { return ["<err " + (e && e.message) + ">"]; }
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (m.kind === "oneof") {
        var inner = [];
        for (var j = 0; j < (m.fields || []).length; j++) inner.push(m.fields[j].localName + ":" + m.fields[j].kind);
        out.push("oneof " + m.localName + " {" + inner.join(", ") + "}");
      } else if (m.kind === "message" && m.T && depth > 0) {
        out.push(m.localName + ":msg[" + dumpFields(m.T, depth - 1).join("; ") + "]");
      } else {
        out.push(m.localName + ":" + m.kind + (m.repeated ? "[]" : "") + (m.opt ? "?" : ""));
      }
    }
    return out;
  }
  function handleDumpStream(service, method, signal, timeoutMs, header, input, contextValues) {
    log("DUMP agent run stream, collecting protocol shape...");
    (async function () {
      try {
        var n = 0;
        for await (var m of input) {
          n++;
          if (n <= 8) {
            var j = "";
            try { j = JSON.stringify(m.toJson ? m.toJson() : m); } catch (e) { j = "<toJson err>"; }
            dumpStore.requests.push((j || "").slice(0, 30000));
            if (!dumpStore.reqTypeName && m.constructor && m.constructor.typeName) {
              dumpStore.reqTypeName = m.constructor.typeName;
              dumpStore.reqFields = dumpFields(m.constructor, 2);
            }
          }
          if (n >= 64) break;
        }
        dumpStore.collectDone = true;
        log("DUMP collected", n, "request messages");
      } catch (e) { dumpStore.collectError = String(e && e.message); }
    })();
    var RespT = method.O;
    try {
      dumpStore.respTypeName = RespT.typeName;
      dumpStore.respFields = dumpFields(RespT, 2);
    } catch (e) { dumpStore.respFields = ["<err>"]; }
    return Promise.reject(new Error(TAG + " debug dump (agent run) — see __CURSOR_CM__.__dump"));
  }

  /* ============================================================
   * 核心：处理被拦截的流式请求
   * ============================================================ */
  function handleStream(service, method, signal, timeoutMs, header, input, contextValues) {
    var RespT = method.O;
    var key = service.typeName + "/" + method.name;
    var isCmdK = service.typeName === "aiserver.v1.CmdKService";
    var isAgentRun = service.typeName === "agent.v1.AgentService" && method.name === "Run";
    var isBidi = method.kind === 3 /* MethodKind.BiDiStreaming */ || (/WithTools$/.test(method.name) && !/SSE$|Poll$|Idempotent$/.test(method.name));

    // 收集 input（ServerStreaming 单条；BiDi 收集窗口 800ms / agent 上限 1024 条供工具结果回传）
    var collectCap = isAgentRun ? 1024 : 64;
    var collected = [];
    var collectResolve = null;
    var collectSettled = false;
    function settleCollect() {
      if (collectSettled) return;
      collectSettled = true;
      if (collectResolve) collectResolve(collected.slice());
    }
    var collectPromise = (async function () {
      try {
        for await (var m of input) {
          collected.push(m);
          // agent 诊断: 记录每条输入消息的 case(找结果回传通道)
          if (isAgentRun) {
            try {
              stats.agentInLog = stats.agentInLog || [];
              if (stats.agentInLog.length < 300) {
                stats.agentInLog.push(String(m && m.message && m.message.case || "?") +
                  (m && m.message && m.message.case === "execClientMessage"
                    ? "{id:" + (m.message.value.id != null ? String(m.message.value.id) : "-") +
                      ",execId:" + (m.message.value.execId || "-") +
                      ",inner:" + String(m.message.value.message && m.message.value.message.case || "-") + "}"
                    : ""));
              }
            } catch (eLog) { /* noop */ }
          }
          // agent: 一旦收到 runRequest 立即放行(客户端可能先发心跳/prewarm, runRequest 携带完整请求)
          if (isAgentRun && m && m.message && m.message.case === "runRequest") {
            settleCollect();
          }
          if (collected.length >= collectCap) break;
        }
        if (isAgentRun) stats.agentInputDone = true; // 输入流结束(客户端半关闭)
      } catch (e) {
        if (isAgentRun) stats.agentInputError = String(e && e.message);
      }
      settleCollect();
      return collected;
    })();
    var collectGate = new Promise(function (resolve) { collectResolve = resolve; });
    function withWindow(p, ms) {
      return new Promise(function (resolve) {
        var t = setTimeout(function () { resolve(collected.slice()); }, ms);
        p.then(function (v) { clearTimeout(t); resolve(v); }, function () { clearTimeout(t); resolve(collected.slice()); });
      });
    }
    // agent: 等待 runRequest 出现(立即放行)或 8s 兜底; 其他 BiDi: 800ms 窗口
    var collectPhase = isAgentRun
      ? withWindow(Promise.race([collectGate, collectPromise]), 8000)
      : (isBidi ? withWindow(collectPromise, 800) : collectPromise);

    var planPromise = collectPhase.then(function (list) {
      var req, meta, out;
      if (isAgentRun) {
        var plan = agentRunToPlan(list);
        if (!plan) { throw new Error(TAG + " agent run: no runRequest in stream"); }
        try { plan.system = buildAgentSystemPrompt(plan); } catch (eSys) { plan.system = ""; }
        try { stats.agentDebug = { actionCase: plan.actionCase, textLen: plan.text.length, msgCount: list.length, convId: !!plan.convId, sysLen: plan.system.length, rcFrom: plan.rcFrom }; } catch (eS) { /* noop */ }
        req = plan.modelReq;
        meta = { agentPlan: plan };
        out = agentBuildMessages(plan);
      } else if (isCmdK) {
        var r1 = cmdkToMessages(list[0] || {});
        req = list[0] || {};
        meta = { sel: r1.sel };
        out = r1.messages;
      } else if (isBidi) {
        req = bidiToRequest(list);
        meta = { chatReq: req };
        out = unifiedToMessages(req);
      } else {
        // ServerStreaming: 单条请求，可能被 clientChunk/streamUnifiedChatRequest 包装
        req = unwrapChatRequest(list[0], 0) || list[0] || {};
        meta = {};
        out = unifiedToMessages(req);
      }
      var model = resolveModel(req);
      log("intercept", key, "→", model, "| messages:", out.length, "| sel:", !!(meta && meta.sel));
      return { messages: out, model: model, meta: meta || {} };
    });

    // 响应发射器
    var emitter = resolveEmitter(RespT, 0);
    // Chat 工具通道: BiDi 且响应链上存在 clientSideToolV2Call 时启用
    var chatToolsPlan = (!isCmdK && !isAgentRun && isBidi && emitter && AGENT_TOOLS_ON)
      ? resolveChatToolPath(emitter, RespT) : null;
    var cmdkPlan = null;
    if (isCmdK) {
      // CmdK: realResponse → editStart/editStream/editEnd | chat
      var fReal = findFieldDeep(RespT, "realResponse");
      var InnerT = (fReal && fReal.kind === "message" && fReal.T) ? fReal.T : RespT;
      cmdkPlan = {
        realField: fReal || null,
        startField: findFieldDeep(InnerT, "editStart"),
        streamField: findFieldDeep(InnerT, "editStream"),
        endField: findFieldDeep(InnerT, "editEnd"),
        chatField: findFieldDeep(InnerT, "chat"),
        innerType: InnerT
      };
    }

    // CmdK 消息构造: outer RespT 包 realResponse(可选) 包 inner oneof
    function cmdkMsg(innerFieldName, innerInit) {
      try {
        var f = cmdkPlan[innerFieldName];
        if (!f) return null;
        var p = setField({}, f, innerInit);
        if (cmdkPlan.realField && cmdkPlan.realField !== f) {
          var innerMsg = new cmdkPlan.innerType(p);
          var p2 = setField({}, cmdkPlan.realField, innerMsg);
          return new RespT(p2);
        }
        return new RespT(p);
      } catch (e) { err("cmdkMsg failed:", e && e.message); return null; }
    }

    /* ---------- agent.v1 循环生成器: 多轮上游调用 + 工具往返 ---------- */
    function findExecResult(callId, from) {
      var fallback = null;
      for (var i = from; i < collected.length; i++) {
        var m = collected[i];
        if (!m || !m.message || m.message.case !== "execClientMessage") continue;
        var ex = m.message.value;
        if (!ex) continue;
        var mid = (ex.id != null) ? String(ex.id) : "";
        var eid = ex.execId || "";
        if (mid === callId || eid === callId) return { ex: ex, idx: i, matched: "id" };
        if (!fallback) fallback = { ex: ex, idx: i, matched: "fifo" }; // FIFO 兜底: 客户端顺序回传的第一条未消费结果
      }
      return fallback;
    }
    async function* agentOutputLoop(info) {
      var fInter = findFieldDeep(RespT, "interactionUpdate");
      var InteractionT = (fInter && fInter.kind === "message" && fInter.T) ? fInter.T : null;
      if (!InteractionT) throw new Error(TAG + " agent: no interactionUpdate on " + RespT.typeName);
      var ap = {
        interField: fInter,
        interType: InteractionT,
        outerType: RespT,
        heartbeatField: findFieldDeep(InteractionT, "heartbeat"),
        thinkingField: findFieldDeep(InteractionT, "thinkingDelta"),
        textField: findFieldDeep(InteractionT, "textDelta"),
        turnEndedField: findFieldDeep(InteractionT, "turnEnded"),
        toolStartedField: findFieldDeep(InteractionT, "toolCallStarted"),
        toolCompletedField: findFieldDeep(InteractionT, "toolCallCompleted")
      };
      if (!ap.textField) throw new Error(TAG + " agent: no textDelta on " + InteractionT.typeName);
      var self = this;
      function mk(field, init) {
        try {
          var interPartial = {};
          setField(interPartial, field, new field.T(init));
          var outer = {};
          setField(outer, ap.interField, new ap.interType(interPartial));
          return new RespT(outer);
        } catch (e) { err("agentUpdate failed:", e && e.message); return null; }
      }
      // 心跳预发: 防客户端等待首包超时
      if (ap.heartbeatField) { var hb0 = mk(ap.heartbeatField, {}); if (hb0) yield hb0; }

      var messages = info.messages.slice();
      var toolsOn = AGENT_TOOLS_ON && ap.toolStartedField && ap.toolCompletedField;
      var mcpTools = [];
      try {
        mcpTools = (info.meta && info.meta.agentPlan && info.meta.agentPlan.requestContext
          && info.meta.agentPlan.requestContext.tools) || [];
      } catch (eMcp) { mcpTools = []; }
      var tools = toolsOn ? agentToolSchemas(mcpTools) : null;
      var finalText = "";
      var watermark = collected.length; // 工具结果只从 watermark 之后匹配
      var callSeq = 0;

      for (var round = 0; round < AGENT_MAX_ROUNDS; round++) {
        var res;
        try {
          res = await callUpstream(messages, info.model, signal, tools);
        } catch (e) {
          if (e && e.name === "AbortError") throw e;
          throw new Error(TAG + " upstream fetch failed: " + (e && e.message));
        }
        if (!res.ok) {
          var errText2 = "";
          try { errText2 = await res.text(); } catch (eT) { /* noop */ }
          err("upstream error", res.status, errText2 && errText2.slice(0, 300));
          throw new Error(TAG + " upstream API " + res.status + ": " + String(errText2).slice(0, 300));
        }
        var it = sseIterator(res);
        var accText = "";
        var pending = {}; // SSE index → {id,name,args}
        try {
          while (true) {
            var r;
            try { r = await it.next(); }
            catch (eR) {
              if (eR && eR.name === "AbortError") throw eR;
              throw new Error(TAG + " stream read failed: " + (eR && eR.message));
            }
            if (r.done) break;
            var part = r.value;
            if (!part) continue;
            if (part.type === "reasoning" && !CFG.sendReasoningAsText) {
              if (ap.thinkingField) { var tm = mk(ap.thinkingField, { text: part.text }); if (tm) yield tm; }
              continue;
            }
            if (part.type === "toolCall") {
              var tcs = part.toolCalls || [];
              for (var ti = 0; ti < tcs.length; ti++) {
                var tc = tcs[ti] || {};
                var tidx = (tc.index != null) ? tc.index : 0;
                if (!pending[tidx]) pending[tidx] = { id: "", name: "", args: "" };
                if (tc.id) pending[tidx].id = String(tc.id);
                var fn = tc.function || {};
                if (fn.name) pending[tidx].name = String(fn.name);
                if (fn.arguments) pending[tidx].args += String(fn.arguments);
              }
              continue;
            }
            if (part.type === "text" && part.text) {
              finalText += part.text;
              accText += part.text;
              var am = mk(ap.textField, { text: part.text });
              if (am) yield am;
            }
          }
        } finally {
          if (it && typeof it["return"] === "function") {
            try { it["return"](); } catch (eCleanup2) { /* noop */ }
          }
        }

        var calls = Object.keys(pending).map(function (k) { return pending[k]; })
          .filter(function (c) { return c.name && resolveAgentTool(c.name, mcpTools); });
        if (!calls.length || !toolsOn) break; // 纯文本回合 → 结束循环

        log("agent round", round + 1, "| tool calls:", calls.length, "(" + calls.map(function (c) { return c.name; }).join(",") + ")");
        // assistant tool_calls 消息(OpenAI 格式)
        messages.push({
          role: "assistant",
          content: accText || null,
          tool_calls: calls.map(function (c) {
            return { id: c.id || ("call_" + (++callSeq)), type: "function", function: { name: c.name, arguments: c.args || "{}" } };
          })
        });

        for (var ci = 0; ci < calls.length; ci++) {
          var c2 = calls[ci];
          if (!c2.id) c2.id = "call_" + (++callSeq);
          var argsObj = {};
          try { argsObj = JSON.parse(c2.args || "{}"); } catch (eJ) { argsObj = {}; }
          // 三段式协议: 1) toolCallStarted(UI 展示) 2) execServerMessage(真实执行指令)
          // 3) 等待 execClientMessage 结果 → toolCallCompleted 收尾
          var resolved = resolveAgentTool(c2.name, mcpTools);
          if (!resolved) continue;
          var stMsg = buildAgentToolUpdate(ap, ap.toolStartedField, c2.id, resolved, argsObj, null);
          if (stMsg) yield stMsg;
          var execMsg = buildExecServerUpdate(RespT, callSeq * 1000 + ci, c2.id, resolved, argsObj);
          if (!execMsg) { log("no execServerMessage channel, skip exec"); }
          if (execMsg) yield execMsg;
          // 等待客户端回传 ExecClientMessage 结果(期间心跳保活)
          var resultMsg = null;
          var deadline = Date.now() + AGENT_TOOL_TIMEOUT;
          var lastHb = Date.now();
          while (Date.now() < deadline) {
            var found = findExecResult(c2.id, watermark);
            if (found) {
              var exr = found.ex;
              log("tool result", found.matched, "| id=" + (exr.id != null ? String(exr.id) : "-"),
                "execId=" + (exr.execId || "-"), "case=" + ((exr.message && exr.message.case) || "-"));
              var g = exr.message;
              resultMsg = (g && g.case && g.value) ? g.value : exr;
              watermark = found.idx + 1; // 消费到该条(顺序推进)
              break;
            }
            if (signal && signal.aborted) break;
            if (ap.heartbeatField && Date.now() - lastHb > 4000) {
              lastHb = Date.now();
              var hbT = mk(ap.heartbeatField, {});
              if (hbT) yield hbT;
            }
            await new Promise(function (rs) { setTimeout(rs, 120); });
          }
          // toolCallCompleted(带结果回填, UI 收尾)
          var cpMsg = buildAgentToolUpdate(ap, ap.toolCompletedField, c2.id, resolved, argsObj, null);
          if (cpMsg) yield cpMsg;
          var resultText = resultMsg
            ? serializeToolResult(resultMsg).slice(0, 60000)
            : "(tool execution timed out or was not executed by the client)";
          messages.push({ role: "tool", tool_call_id: c2.id, content: resultText });
        }
      }

      if (!finalText) {
        finalText = "(model returned empty response)";
        var em2 = mk(ap.textField, { text: finalText });
        if (em2) yield em2;
      }
      if (ap.turnEndedField) {
        var te = mk(ap.turnEndedField, {});
        if (te) yield te;
      }
      try {
        var apl = info.meta && info.meta.agentPlan;
        if (apl) agentRemember(apl.convId, apl.text, finalText);
      } catch (eHist2) { /* noop */ }
      log("done", key, "| agent final:", finalText.slice(0, 80));
    }

    /* ---------- Chat 界面 (aiserver.v1) 工具循环生成器 ---------- */
    // 沿 emitter 链定位含 clientSideToolV2Call 的层: 记录各层类型与包装字段
    // tp = {types:[外层..内层], ems:[wrap层], at: callField 所在层下标, callField}
    function resolveChatToolPath(em, RespT2) {
      var types = [RespT2];
      var ems = [];
      var cur = em;
      while (cur && cur.kind === "wrap") {
        types.push(cur.field.T);
        ems.push(cur);
        cur = cur.sub;
      }
      for (var i = 0; i < types.length; i++) {
        var f = findFieldDeep(types[i], "clientSideToolV2Call");
        if (f && f.kind === "message" && f.T) return { types: types, ems: ems, at: i, callField: f };
      }
      return null;
    }
    // 从 at 层 partial 向外包装到最外层响应类型
    function buildChatToolCallMsg(tp, callPartial) {
      try {
        var p = setField({}, tp.callField, new tp.callField.T(callPartial));
        for (var i = tp.at; i > 0; i--) {
          var em = tp.ems[i - 1];
          p = setField({}, em.field, new em.field.T(p));
        }
        return new tp.types[0](p);
      } catch (e) { err("chat toolCall build failed:", e && e.message); return null; }
    }
    // 请求流控制包解包: request oneof 沿 clientChunk/streamUnifiedChatRequest 深入, 命中 clientSideToolV2Result
    function unwrapChatToolResult(m) {
      var cur = m, d = 0;
      while (cur && d < 6) {
        var r = cur.request;
        if (r && r.case && r.value) {
          if (r.case === "clientSideToolV2Result") return r.value;
          if (r.case === "clientChunk" || r.case === "streamUnifiedChatRequest") { cur = r.value; d++; continue; }
        }
        return null;
      }
      return null;
    }
    function findChatToolResult(callId, from) {
      var fallback = null;
      for (var i = from; i < collected.length; i++) {
        var res = unwrapChatToolResult(collected[i]);
        if (!res) continue;
        if (String(res.toolCallId || "") === String(callId)) return { res: res, idx: i, matched: "id" };
        if (!fallback) fallback = { res: res, idx: i, matched: "fifo" }; // FIFO 兜底
      }
      return fallback;
    }
    function chatToolResultText(res) {
      try {
        if (res && res.error) return "Error: " + String(res.error.message || res.error.msg || res.error);
      } catch (e) { /* noop */ }
      return serializeToolResult(res).slice(0, 60000);
    }
    async function* chatOutputLoop(info) {
      var tp = chatToolsPlan;
      var CallT = tp.callField.T;
      var toolField = findFieldDeep(CallT, "tool");
      var EnumT = toolField && toolField.T; // protobuf-es enum 对象: 名 -> 数字
      var fId = findFieldDeep(CallT, "toolCallId");
      var fName = findFieldDeep(CallT, "name");
      var fRawArgs = findFieldDeep(CallT, "rawArgs");
      if (!toolField || !EnumT) throw new Error(TAG + " chat tools: no tool enum on " + CallT.typeName);
      var mcpTools = [];
      try {
        mcpTools = (info.meta && info.meta.chatReq && info.meta.chatReq.requestContext
          && info.meta.chatReq.requestContext.tools) || [];
      } catch (eM2) { mcpTools = []; }
      var tools = chatToolSchemas(EnumT, mcpTools);
      if (emitter && emitter.kind === "wrap") {
        var ss2 = maybeStreamStart(RespT);
        if (ss2) yield ss2;
      }
      var messages = info.messages.slice();
      var finalText = "";
      var watermark = collected.length;
      var callSeq = 0;
      for (var round = 0; round < AGENT_MAX_ROUNDS; round++) {
        var res;
        try {
          res = await callUpstream(messages, info.model, signal, tools.length ? tools : null);
        } catch (e) {
          if (e && e.name === "AbortError") throw e;
          throw new Error(TAG + " upstream fetch failed: " + (e && e.message));
        }
        if (!res.ok) {
          var errText3 = "";
          try { errText3 = await res.text(); } catch (eT3) { /* noop */ }
          err("upstream error", res.status, errText3 && errText3.slice(0, 300));
          throw new Error(TAG + " upstream API " + res.status + ": " + String(errText3).slice(0, 300));
        }
        var it = sseIterator(res);
        var accText = "";
        var pending = {};
        try {
          while (true) {
            var r;
            try { r = await it.next(); }
            catch (eR2) {
              if (eR2 && eR2.name === "AbortError") throw eR2;
              throw new Error(TAG + " stream read failed: " + (eR2 && eR2.message));
            }
            if (r.done) break;
            var part = r.value;
            if (!part) continue;
            if (part.type === "reasoning" && !CFG.sendReasoningAsText) {
              var tm2 = makeRespMsg(emitter, RespT, null, part.text);
              if (tm2) yield tm2;
              continue;
            }
            if (part.type === "toolCall") {
              var tcs2 = part.toolCalls || [];
              for (var ti2 = 0; ti2 < tcs2.length; ti2++) {
                var tc2 = tcs2[ti2] || {};
                var tidx2 = (tc2.index != null) ? tc2.index : 0;
                if (!pending[tidx2]) pending[tidx2] = { id: "", name: "", args: "" };
                if (tc2.id) pending[tidx2].id = String(tc2.id);
                var fn2 = tc2.function || {};
                if (fn2.name) pending[tidx2].name = String(fn2.name);
                if (fn2.arguments) pending[tidx2].args += String(fn2.arguments);
              }
              continue;
            }
            if (part.type === "text" && part.text) {
              finalText += part.text;
              accText += part.text;
              var am2 = makeRespMsg(emitter, RespT, part.text, null);
              if (am2) yield am2;
            }
          }
        } finally {
          if (it && typeof it["return"] === "function") {
            try { it["return"](); } catch (eCleanup3) { /* noop */ }
          }
        }
        var calls = Object.keys(pending).map(function (k) { return pending[k]; })
          .filter(function (c) { return c.name && resolveChatTool(c.name, EnumT, mcpTools); });
        if (!calls.length) break; // 纯文本回合 -> 结束循环
        log("chat tool round", round + 1, "| calls:", calls.length, "(" + calls.map(function (c) { return c.name; }).join(",") + ")");
        messages.push({
          role: "assistant",
          content: accText || null,
          tool_calls: calls.map(function (c) {
            return { id: c.id || ("chatcall_" + (++callSeq)), type: "function", function: { name: c.name, arguments: c.args || "{}" } };
          })
        });
        for (var ci2 = 0; ci2 < calls.length; ci2++) {
          var c3 = calls[ci2];
          if (!c3.id) c3.id = "chatcall_" + (++callSeq);
          var argsObj2 = {};
          try { argsObj2 = JSON.parse(c3.args || "{}"); } catch (eJ2) { argsObj2 = {}; }
          var resolved2 = resolveChatTool(c3.name, EnumT, mcpTools);
          if (!resolved2) continue;
          var callPartial = {};
          if (fId) callPartial.toolCallId = c3.id;
          if (fName) callPartial.name = resolved2.mcp ? (resolved2.mcp.toolName || resolved2.mcp.name) : c3.name;
          setField(callPartial, toolField, EnumT[resolved2.cfg.tool]);
          if (fRawArgs) callPartial.rawArgs = c3.args || "{}";
          var pc = findFieldDeep(CallT, resolved2.cfg.paramsCase);
          if (pc && pc.T) {
            var pp = chatParamsPartial(resolved2.cfg, resolved2.mcp, argsObj2);
            setField(callPartial, pc, new pc.T(partialFor(pc.T, pp)));
          }
          var toolMsg = buildChatToolCallMsg(tp, callPartial);
          if (toolMsg) yield toolMsg;
          // 等待客户端回传 clientSideToolV2Result
          var resultMsg2 = null;
          var deadline2 = Date.now() + AGENT_TOOL_TIMEOUT;
          while (Date.now() < deadline2) {
            var found2 = findChatToolResult(c3.id, watermark);
            if (found2) {
              resultMsg2 = found2.res;
              log("chat tool result", found2.matched, "| id=" + String(resultMsg2.toolCallId || "-"));
              watermark = found2.idx + 1;
              break;
            }
            if (signal && signal.aborted) break;
            await new Promise(function (rs2) { setTimeout(rs2, 120); });
          }
          var resultText2 = resultMsg2
            ? chatToolResultText(resultMsg2)
            : "(tool execution timed out or was not executed by the client)";
          messages.push({ role: "tool", tool_call_id: c3.id, content: resultText2 });
        }
      }
      if (!finalText) {
        finalText = "(model returned empty response)";
        var em3 = makeRespMsg(emitter, RespT, finalText, null);
        if (em3) yield em3;
      }
      log("done", key, "| chat final:", finalText.slice(0, 80));
    }

    async function* output() {
      var info;
      try {
        info = await planPromise;
      } catch (e) {
        throw new Error(TAG + " request extraction failed: " + (e && e.message));
      }
      // agent.v1: 独立循环生成器(支持多轮工具调用), 不走下方单轮路径
      if (isAgentRun) {
        yield* agentOutputLoop(info);
        return;
      }
      // Chat 界面工具通道(clientSideToolV2Call 往返), 不走下方单轮路径
      if (chatToolsPlan) {
        yield* chatOutputLoop(info);
        return;
      }
      var res;
      try {
        res = await callUpstream(info.messages, info.model, signal);
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        throw new Error(TAG + " upstream fetch failed: " + (e && e.message));
      }
      if (!res.ok) {
        var errText = "";
        try { errText = await res.text(); } catch (e) { /* noop */ }
        err("upstream error", res.status, errText && errText.slice(0, 300));
        throw new Error(TAG + " upstream API " + res.status + ": " + String(errText).slice(0, 300));
      }

      var useCmdkEdit = isCmdK && cmdkPlan && info.meta && info.meta.sel &&
        cmdkPlan.startField && cmdkPlan.streamField && cmdkPlan.endField;
      var useCmdkChat = isCmdK && !useCmdkEdit && cmdkPlan && cmdkPlan.chatField;

      if (!useCmdkEdit && !useCmdkChat && !emitter) {
        throw new Error(TAG + " cannot build response message for " + RespT.typeName);
      }

      // BTe 等包装类型: 先发 streamStart（若存在）
      if (!isCmdK && emitter && emitter.kind === "wrap") {
        var ss = maybeStreamStart(RespT);
        if (ss) yield ss;
      }

      var it = sseIterator(res);
      var sent = 0;
      var fullText = "";
      var allText = "";
      var EDIT_ID = 1;
      var selStart = (info.meta && info.meta.sel && info.meta.sel.startLineNumber) || 1;
      var started = false;

      // try/finally: 消费者提前 return()/throw 时取消上游 SSE reader, 避免 fetch 流后台泄漏
      try {
        while (true) {
          var r;
          try { r = await it.next(); }
          catch (e) {
            if (e && e.name === "AbortError") throw e;
            throw new Error(TAG + " stream read failed: " + (e && e.message));
          }
          if (r.done) break;
          var part = r.value;
          if (!part || !part.text) continue;

          if (part.type === "reasoning" && !CFG.sendReasoningAsText) {
            var thinkMsg = null;
            if (useCmdkEdit || useCmdkChat) {
              // CmdK 响应类型无 thinking 字段，跳过
            } else if (emitter) {
              thinkMsg = makeRespMsg(emitter, RespT, null, part.text);
            }
            if (thinkMsg) { yield thinkMsg; }
            continue;
          }

          var piece = part.text;
          allText += piece;
          if (useCmdkEdit) {
            if (!started) {
              started = true;
              var sm = cmdkMsg("startField", {
                startLineNumber: selStart,
                editId: EDIT_ID,
                // 上限放宽到 4096 行: 模型输出可能比原选区长, 紧贴原行数会被 UI 截断
                maxEndLineNumberExclusive: selStart + 4096
              });
              if (sm) yield sm;
            }
            fullText += piece;
            var em = cmdkMsg("streamField", { text: piece, editId: EDIT_ID });
            if (em) { yield em; sent++; }
          } else if (useCmdkChat) {
            var cm = cmdkMsg("chatField", { text: piece });
            if (cm) { yield cm; sent++; }
          } else {
            var msg = makeRespMsg(emitter, RespT, piece, null);
            if (msg) { yield msg; sent++; }
          }
        }
      } finally {
        if (it && typeof it["return"] === "function") {
          try { it["return"](); } catch (eCleanup) { /* noop */ }
        }
      }

      if (useCmdkEdit) {
        var lineCount = Math.max(1, fullText.split("\n").length);
        var endMsg = cmdkMsg("endField", {
          endLineNumberExclusive: selStart + lineCount,
          editId: EDIT_ID
        });
        if (endMsg) yield endMsg;
      }
      // 空回复兜底: 补一条占位文本(agent 由 agentOutputLoop 自行处理)
      if (sent === 0 && !useCmdkEdit) {
        if (useCmdkChat) {
          var cm2 = cmdkMsg("chatField", { text: "(model returned empty response)" });
          if (cm2) yield cm2;
        } else if (emitter) {
          var m2 = makeRespMsg(emitter, RespT, "(model returned empty response)", null);
          if (m2) yield m2;
        }
      }
      // 预览日志(前80字符): 便于用户在 DevTools Console 确认真实回复内容
      var preview = (useCmdkEdit ? fullText : allText).slice(0, 80);
      log("done", key, "| chunks:", sent, "| preview:", preview);
    }

    // 注意: Cursor 调用方消费 {message, header, trailer}（源码 callSharedConnectStream:
    // `for await(const k of _.message)` / `_.header.entries()`），字段名是 message 而非 connect-es v2 的 output
    return Promise.resolve({
      stream: true,
      service: service,
      method: method,
      header: new Headers(),
      trailer: new Headers(),
      message: output()
    });
  }

  /* ---------- Transport 包装 (Proxy: 非目标方法原样转发) ---------- */
  var stats = { gate: 0, intercept: 0, passthroughUnary: 0, passthroughStream: 0, seenStream: {}, seenUnary: {} };
  function noteSeen(map, service, method) {
    try {
      var key = service.typeName + "/" + method.name + " (kind=" + method.kind + ")";
      if (!map[key]) { map[key] = 1; log("passthrough-not-target:", key); }
      else map[key]++;
    } catch (e) { /* noop */ }
  }
  function wrapTransport(orig) {
    if (!orig) return orig;
    return new Proxy(orig, {
      get: function (target, prop) {
        if (prop === "unary") {
          return function () {
            var args = Array.prototype.slice.call(arguments);
            var svcU = args[0], mthU = args[1];
            if (isUsageGate(svcU, mthU)) {
              try {
                stats.gate++;
                return handleGateUnary(svcU, mthU);
              }
              catch (eGate) { err("usage-gate bypass failed:", eGate && eGate.message); }
            }
            stats.passthroughUnary++;
            noteSeen(stats.seenUnary, svcU, mthU);
            return target.unary.apply(target, args);
          };
        }
        if (prop === "stream") {
          return function () {
            var args = Array.prototype.slice.call(arguments);
            var service = args[0], method = args[1];
            if (CFG.debugDump && service.typeName === "agent.v1.AgentService" && method.name === "Run") {
              stats.intercept++;
              return handleDumpStream.apply(null, args);
            }
            if (isTarget(service, method)) {
              try {
                stats.intercept++;
                return handleStream.apply(null, args);
              } catch (e) {
                err("handleStream immediate error:", e && e.message, "- 回退原通道");
                return target.stream.apply(target, args);
              }
            }
            stats.passthroughStream++;
            noteSeen(stats.seenStream, service, method);
            return target.stream.apply(target, args);
          };
        }
        var v = target[prop];
        if (typeof v === "function") return v.bind(target);
        return v;
      }
    });
  }

  g.__CURSOR_CM__ = {
    active: true,
    version: "1.6.1",
    stats: stats,
    __dump: dumpStore,
    config: {
      baseUrl: CFG.baseUrl,
      defaultModel: CFG.defaultModel,
      interceptMethods: CFG.interceptMethods || []
    },
    wrap: wrapTransport
  };
  log("runtime active →", CFG.baseUrl, "| targets:", (CFG.interceptMethods || []).length);
})();
