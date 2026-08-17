// 读取渲染进程 __CURSOR_CM__.stats（含 seenStream/seenUnary 方法名记录）
// 零依赖: 使用 Node 22+ 内置全局 WebSocket
const http = require("http");
function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: 9222, path }, r => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => res(JSON.parse(d)));
    }).on("error", rej);
  });
}
(async () => {
  const targets = await get("/json/list");
  const pages = targets.filter(t => t.type === "page");
  for (const p of pages) {
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    let id = 0; const pending = {};
    const send = (method, params) => new Promise((res) => {
      const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params }));
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; }
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail: " + p.title)); });
    const r = await send("Runtime.evaluate", {
      expression: `JSON.stringify(globalThis.__CURSOR_CM__ ? {stats: __CURSOR_CM__.stats, dump: __CURSOR_CM__.__dump} : null, null, 1)`,
      returnByValue: true
    });
    console.log("=== " + p.title + " ===");
    console.log(r.result.value);
    ws.close();
  }
  process.exit(0);
})().catch(e => { console.log("ERR", e.message); process.exit(1); });
