// ============================================================
// CDP 端到端实测脚本 v1.2 (CDP Input 注入版)
// 前提: Cursor 以 --remote-debugging-port=9222 启动
// 步骤: 校验 runtime → Ctrl+L → DOM 聚焦输入框 → Input.insertText
//       → CDP Enter → 捕获 [CustomModels] 日志 + stats + 页面文本证据
// ============================================================
"use strict";
const http = require("http");
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function main() {
  const list = await httpGetJson("/json/list");
  const pages = list.filter((t) => t.type === "page");
  const target = pages.find((t) => /workbench/i.test(t.url)) || pages.find((t) => /cursor/i.test(t.title || "")) || pages[0];
  if (!target) { console.error("E2E: 无 page target"); process.exit(2); }
  console.log("E2E target:", target.title);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });

  let seq = 0;
  const pending = new Map();
  const cmLogs = [];
  const otherErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const txt = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || ""))).join(" ");
      if (txt.includes("[CustomModels]")) cmLogs.push(`[${m.params.type}] ${txt}`);
      else if (m.params.type === "error" && otherErrors.length < 10) otherErrors.push(txt.slice(0, 250));
    }
    if (m.method === "Runtime.exceptionThrown" && otherErrors.length < 10) {
      const d = m.params.exceptionDetails;
      otherErrors.push("EXC: " + ((d.exception && d.exception.description) || d.text || "").slice(0, 250));
    }
  };
  function send(method, params = {}) {
    return new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async function ev(expression) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return "EVAL_ERR: " + (r.result.exceptionDetails.exception?.description || "").slice(0, 150);
    return r.result.result.value;
  }
  await send("Runtime.enable");

  // 1) runtime 状态
  const st = await ev("JSON.stringify(globalThis.__CURSOR_CM__?{active:__CURSOR_CM__.active,version:__CURSOR_CM__.version,stats:__CURSOR_CM__.stats}:null)");
  console.log("RUNTIME_STATE:", st);

  // 2) Ctrl+L (聚焦聊天)
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, key: "l", code: "KeyL", windowsVirtualKeyCode: 76, nativeVirtualKeyCode: 76 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "l", code: "KeyL", windowsVirtualKeyCode: 76, nativeVirtualKeyCode: 76 });
  await sleep(1500);

  // 3) DOM 聚焦聊天输入框 (取可见的最后一个 contenteditable/textarea)
  const focused = await ev(`(function(){
    var eds = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], .ProseMirror'));
    var vis = eds.filter(function(e){ var r = e.getBoundingClientRect(); return r.width > 100 && r.height > 16; });
    if (!vis.length) return "NO_INPUT (total=" + eds.length + ")";
    var el = vis[vis.length - 1];
    el.focus();
    var a = document.activeElement === el;
    return (a ? "FOCUSED:" : "FOCUS_FAIL:") + el.tagName + "|" + el.getAttribute("class") + "|" + el.getAttribute("role");
  })()`);
  console.log("FOCUS:", focused);
  if (!/^FOCUSED/.test(String(focused))) {
    console.log("E2E 判定: 无法定位聊天输入框");
    ws.close(); process.exit(1);
  }

  // 4) 清空输入框残留 (Ctrl+A + Delete) 后 CDP insertText
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await sleep(150);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await sleep(200);
  await send("Input.insertText", { text: "你好，请只回复四个字：测试成功" });
  await sleep(800);
  const val = await ev(`(function(){
    var el = document.activeElement;
    if (!el) return "NO_ACTIVE";
    var t = (el.value || el.textContent || "").trim();
    return t ? "TYPED:" + t.slice(0, 50) : "EMPTY";
  })()`);
  console.log("TYPED:", val);

  // 5) CDP Enter 发送 (真实键盘事件流)
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(1200);

  // 6) 兜底: 若输入框仍有全文且页面有发送按钮, 点击它
  const stillThere = await ev(`(function(){
    var el = document.activeElement;
    if (!el) return "";
    return (el.value || el.textContent || "").trim();
  })()`);
  if (String(stillThere).includes("测试成功")) {
    console.log("Enter 未发送, 尝试点击发送按钮...");
    const clicked = await ev(`(function(){
      var btns = Array.from(document.querySelectorAll('button, [role="button"], div[class*="send" i]'));
      var cand = btns.filter(function(b){
        var r = b.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false;
        var t = (b.getAttribute("aria-label") || "") + " " + (b.textContent || "");
        return /send|提交|发送/i.test(t);
      });
      if (!cand.length) return "NO_BTN";
      cand[cand.length - 1].click();
      return "CLICKED";
    })()`);
    console.log("SEND_BTN:", clicked);
  }

  // 7) 收集 30s
  for (let i = 0; i < 30; i++) { await sleep(1000); process.stdout.write("."); }
  console.log("");

  // 8) 最终 stats + 页面文本证据
  const st2 = await ev("JSON.stringify(globalThis.__CURSOR_CM__?__CURSOR_CM__.stats:null)");
  console.log("\nRENDERER_STATS:", st2);
  const bodyTail = await ev(`document.body.innerText.replace(/\\n{2,}/g,"\\n").slice(-700)`);
  console.log("\n===== 页面文本(末700字) =====");
  console.log(bodyTail);

  console.log("\n===== [CustomModels] 渲染进程日志 =====");
  if (!cmLogs.length) console.log("(无 — 聊天拦截发生在扩展主机, 日志在扩展主机控制台)");
  cmLogs.forEach((l) => console.log(l));
  if (otherErrors.length) {
    console.log("\n===== 其它渲染错误(前10条) =====");
    otherErrors.forEach((l) => console.log(l));
  }

  const okActive = /"active":true/.test(st || "");
  const bodyOk = await ev(`(function(){
    var t = document.body.innerText;
    return JSON.stringify({ hasReply: /测试成功/.test(t.slice(0,-200)) || /成功/.test(t.slice(-400)), paused31: /31 days/.test(t), pausedAny: /You're paused/.test(t) });
  })()`);
  const j = JSON.parse(bodyOk || "{}");
  console.log("\n===== E2E 判定 =====");
  console.log("runtime active:", okActive ? "PASS" : "FAIL");
  console.log("收到回复(页面含'成功'):", j.hasReply ? "PASS" : "FAIL");
  console.log("paused 横幅(31天):", j.paused31 ? "FAIL" : "PASS(无)");
  console.log("paused 横幅(任何):", j.pausedAny ? "WARN(旧对话残留)" : "PASS(无)");
  ws.close();
  process.exit(okActive && j.hasReply && !j.paused31 ? 0 : 1);
}

main().catch((e) => { console.error("E2E ERROR:", e.message); process.exit(3); });
