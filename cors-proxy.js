// ============================================================
// 本地 CORS 代理 v1.0 (零依赖, Node 16+)
// 用途: Cursor 渲染进程 fetch 直连某些 API(如 GLM open.bigmodel.cn)
//       会被浏览器 CORS 拦截(实测该端点对 OPTIONS 预检返回 405)。
//       本代理注入 CORS 响应头, 并透传流式(SSE)响应。
//
// 用法: node cors-proxy.js <上游Origin> [端口]
//   例: node cors-proxy.js https://open.bigmodel.cn 8117
//   然后 config.json 的 baseUrl 改为:
//       http://127.0.0.1:8117/api/paas/v4
//
// DeepSeek / SiliconFlow 实测支持 CORS, 无需本代理。
// ============================================================
"use strict";
const http = require("http");
const https = require("https");
const { URL } = require("url");

const UPSTREAM = process.argv[2];
if (!UPSTREAM) {
  console.error("用法: node cors-proxy.js <上游Origin> [端口]   例: node cors-proxy.js https://open.bigmodel.cn 8117");
  process.exit(1);
}
const PORT = parseInt(process.argv[3] || "8117", 10);
const upstream = new URL(UPSTREAM);
const client = upstream.protocol === "https:" ? https : http;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400"
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const target = new URL(req.url, UPSTREAM);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  headers.host = upstream.host;

  const upReq = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers
    },
    (upRes) => {
      const h = { ...upRes.headers, ...CORS };
      res.writeHead(upRes.statusCode, h);
      upRes.pipe(res); // 流式透传 (SSE)
    }
  );
  // 客户端提前断开时中止上游请求, 避免后台继续下载
  res.on("close", () => { if (!res.writableEnded) upReq.destroy(); });
  upReq.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, CORS);
    res.end("proxy error: " + e.message);
  });
  req.pipe(upReq);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[cors-proxy] http://127.0.0.1:${PORT}  →  ${UPSTREAM}`);
  console.log(`[cors-proxy] config.json baseUrl 填: http://127.0.0.1:${PORT}<路径前缀>`);
});
