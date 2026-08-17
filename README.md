# Cursor 自定义模型集成方案（DeepSeek / GLM / 任意 OpenAI 兼容 API）

**中文** | [English](README.en.md)

![version](https://img.shields.io/badge/version-1.5.1-blue) ![tests](https://img.shields.io/badge/integration_tests-28%2F28-brightgreen) ![license](https://img.shields.io/badge/license-MIT-green) ![platform](https://img.shields.io/badge/platform-Windows-lightgrey) ![cursor](https://img.shields.io/badge/tested_on-Cursor%203.16.x-orange)

> 版本 1.5.1 | 适配 Cursor 3.16.17（Windows）| 逆向分析 + 传输层拦截方案
>
> **v1.5.1 修复（真实协议 dump 实证）**：
> - **requestContext 读取位置修正**：通过协议 dump 发现 3.16.17 的 Agent Run 请求中 `requestContext` 嵌在 `action.userMessageAction.requestContext`（而非顶层 `runRequest.requestContext`）。双位置兼容读取后，环境上下文真实流入系统提示词--E2E 实测 `sysLen` 从 269（仅基础提示词）增至 7832（OS/Shell/时区/工作目录/MCP 指令全量）
> - **MCP 工具 schema 默认不注入**：20+ Cursor 内置浏览器工具的完整 JSON Schema 会撑爆提示词且诱导模型调用无执行通道的工具；新增 `agentContext.mcpToolSchemas` 配置（默认 `false`），并显式声明本会话仅 `read_file`/`grep_search`/`list_dir` 可调用
> - `stats.agentDebug` 新增 `rcFrom` 诊断字段（`userMessageAction` / `runRequest` / `none`）；集成测试 28/28 通过（新增 T28 嵌套位置验证）
>
> **v1.5.0 重大更新："经过模型选择器、不经服务端"（E2E 实测通过）**：
> - **requestContext 全量注入**：系统提示词本地重组装（对标服务端 prompt 组装）——环境信息（OS/Shell/工作目录/时区）、项目规则（.cursorrules 全文）、Git 仓库信息、项目目录树（递归展开）、MCP 服务器指令与工具 schema
> - **Agent 工具调用循环（三段式协议）**：OpenAI function calling ↔ agent.v1 双向转换。模型可发起 `read_file` / `grep_search` / `list_dir`，协议链 `toolCallStarted(UI展示) → execServerMessage(执行指令) → execClientMessage(结果回传) → toolCallCompleted(收尾)`，由 Cursor 客户端**本地真实执行**（读取你的真实文件），结果自动进入下一轮推理——实测 5 秒读取 config.json 并正确回答字段值
> - 工具执行超时自动降级（默认 30s，流程不中断）；多轮上限 8 轮可配
> - 集成测试 27/27 通过（新增 T25 工具循环 / T26 超时降级 / T27 上下文注入）
>
> **v1.4 重大更新（实测全通过）**：
> - 新增 **Cursor Agents 界面**支持：拦截 `agent.v1.AgentService/Run`（Agents 聊天的真实协议，与经典 Chat 面板完全不同）
> - 新增 **Usage 门禁拦截**：`GetUsageLimitStatusAndActiveGrants` / `GetUsageLimitPolicyStatus` 返回空响应，彻底解除 "You're paused until your usage resets" 锁定
> - 新增 **扩展主机补丁**（extensionHostProcess.js）：包装 `registerConnectTransportProvider` 注册的真实 HTTP 传输（无竞态惰性代理）
> - 新增 **product.json 校验和维护**：补丁后自动更新 SHA-256 校验和，消除 "installation appears to be corrupt" 反篡改提示
> - 新增 **多轮对话记忆**：按 `conversationId` 在内存中维护会话历史（每会话最多20轮，最多保留64个会话）
> - 端到端实测：DeepSeek 精准回复、门禁横幅消失、完整性提示消失、多轮记忆通过、集成测试 20/20
>
> **v1.4.1（最终逐字审查修复）**：
> - agent 空回复时 turnEnded 与占位文本去重（恰好发送一次）
> - 会话历史 Map 增加会话数上限（64），防长期运行内存增长
> - `restore.ps1` 补备份完整性校验与 product.json 备份合法性校验；`patch.ps1` 回滚路径加备份存在性守卫
> - 全部 `.bat` 换行符 LF→CRLF（修复 cmd 解析错位导致的 `'01' is not recognized` 类怪错）
> - `stats.js` 去除 `ws` 外部依赖（Node 22+ 内置 WebSocket）；`cors-proxy.js` 客户端断开时中止上游请求
> - **新增 agent.v1 协议集成测试 4 项**（T21-T24），集成测试 24/24 通过

---

## 〇、与同类方案对比（为什么选择本项目）

现有"Cursor 免费/自定义模型"方案普遍存在结构性缺陷：

| # | 共性痛点 | 受影响方案 |
|---|----------|-----------|
| 1 | **必须常驻外部服务器**（Node/Docker/ngrok 隧道/油猴脚本+浏览器不关） | cursor2api 等代理家族 |
| 2 | **封号与风控对抗常态化**（临时邮箱封号、403/429、Cloudflare、token 过期） | 试用重置类、代理类 |
| 3 | **原生 Agent / Cmd+K 仍被锁死**--Cursor 官方明确自定义 API Key 不能用于 Agent（"Composer relies on custom models that cannot be billed to an API key"） | 官方"自定义 API Key"功能 |
| 4 | **无真实工具调用闭环**--外部客户端模拟；Cursor 自己的 `read_file` / `grep_search` 从未被触达 | 所有代理方案 |
| 5 | **更新即失效 + 配置复杂**（minified 锚点变化、product.json 校验和拒绝补丁文件） | 所有 workbench 补丁方案 |

本项目在 Cursor 渲染进程内部拦截 AI 请求，一次性解决全部五个痛点：

| | **本项目** | 试用重置类<br>(cursor-free-vip 等) | API 代理类<br>(cursor2api 家族) | 官方自定义<br>API Key |
|---|---|---|---|---|
| 无需常驻任何服务 | ✅ | ✅（脚本） | ❌ Node/Docker/隧道 | ✅ |
| 用**自己的**模型和 Key | ✅ 任意 OpenAI 兼容 | ❌ 仅 Cursor 模型 | ❌ 转售 Cursor 额度 | ⚠️ 仅 Chat |
| 原生 Agent + Cmd+K 可用 | ✅ | 仅试用 | ❌ 服务外部客户端 | ❌ Agent 被锁 |
| IDE 内真实工具调用 | ✅ read/grep/list_dir | ❌ | ❌ | ❌ |
| `localhost` 端点 | ✅ | 不适用 | 不适用 | ❌ 被封 |
| 无账号/指纹伪装把戏 | ✅ | ❌ 机器码+临时邮箱 | ❌ 共享 Cookie | ✅ |
| 行为由测试锁定 | ✅ 28 项集成测试 | ❌ | 部分 | 不适用 |

> 调研样本：yeongpin/cursor-free-vip（41.7k★，临时邮箱封号问题官方 README 自认）、7836246/cursor2api（~1.8k★，需常驻服务器+风控高发）、yuaotian/go-cursor-help（自动更新即失效，Issue #318）、StenCurry/CurryAPI 等 cursor-api 家族（ngrok 隧道/油猴依赖）、workbench 直改方案（CursorPlus 已归档、localMode 以阉割 Tab/Cmd+K 为代价）。

---

## 一、问题分析（逆向结论）

### 1.1 限制的表现
- 免费版 Settings 中无 "API Keys" / 自定义模型入口
- 模型下拉列表仅显示 Cursor 托管模型，无法添加自定义端点
- 旧版（0.4x）的 "Override OpenAI Base URL" 功能已从 UI 移除

### 1.2 限制的技术原理（三层封锁）

| 层级 | 机制 | 逆向证据 |
|------|------|----------|
| **UI 层** | API Key 面板由服务端 `AvailableModelsResponse.byok_enabled` 字段控制，免费账号下发 `false` | proto 字段14 `byok_enabled` |
| **网络层** | 所有 AI 请求强制经 `api2.cursor.sh`（ConnectRPC 协议），模型列表服务端下发 | 硬编码常量 `Kht="https://api2.cursor.sh"` |
| **数据层** | 客户端 BYOK 基础设施**完整保留但被隐藏** | `ModelDetails.api_key`(字段2)、`openai_api_base_url`(字段6)、`byokModelUtils.js` 均存在 |

### 1.3 突破口
所有 AI RPC 调用（Chat / CmdK / Composer）在渲染进程中汇聚于**单一咽喉点**：

```
aiConnectRequestService.transport()  →  connect-es Transport  →  api2.cursor.sh
```

该函数位于 `workbench.desktop.main.js`（41MB），签名唯一、可字符串定位：
```javascript
async transport(){try{return await gb(this._provider,AbortSignal.timeout(D3u))}
catch{throw new Error("No Connect transport provider registered.")}}
```

## 二、方案原理

```
┌─────────────────────────────────────────────────┐
│ Cursor 渲染进程                                   │
│                                                  │
│  Chat/CmdK 请求 ──→ transport() 返回值(被包装) ──┼──→ 拦截 ──→ DeepSeek/GLM API
│                                                  ││         (OpenAI 兼容 /chat/completions)
│  登录/模型列表/补全 ──→ Proxy 原样转发 ────────────┼──→ api2.cursor.sh (原功能 100% 保留)
└─────────────────────────────────────────────────┘
```

- **拦截**：按 `service.typeName + "/" + method.name` 精确匹配目标方法。默认目标（v1.4）：
  - `ChatService/StreamUnifiedChat`（经典 Chat 面板聊天，ServerStreaming）
  - `ChatService/StreamUnifiedChatWithTools`（Agent，BiDi）
  - `ChatService/StreamUnifiedChatWithToolsIdempotent`（Agent 幂等通道，BiDi，请求需两层递归解包 `clientChunk→streamUnifiedChatRequest`）
  - `CmdKService/StreamCmdK`（Ctrl+K 内联编辑）
  - `agent.v1.AgentService/Run`（**Cursor Agents 界面真实协议**，BiDi；请求提取 `runRequest.action.userMessageAction.userMessage.text`，多轮键 `conversationId`；响应 `interactionUpdate{textDelta{text}}` + `turnEnded{}`，含心跳预发与 thinkingDelta 思考流）
  - **不拦截** `...WithToolsSSE`/`...Poll`：它们是幂等协议的轮询通道，请求类型 `BidiRequestId` 仅含 request_id 无对话内容（逆向证实），拦截会导致空请求
- **请求转换**：protobuf-es v2 已解码对象 → OpenAI messages（角色映射 HUMAN=1/AI=2，附加代码块、工具结果；CmdK 从 `contextItems` 提取指令/选区/文件上下文，填充链已在源码 @37750742 证实）
- **响应构造**：基于 protobuf-es v2 类型内省（`fields.byMember()`/`FieldInfo.oneof`→OneofInfo 对象引用，源码 @2764242 证实）自动解析 oneof 包装路径：
  - `StreamUnifiedChat` → 直接 `text` 字段
  - `StreamUnifiedChatWithTools` → `response.streamUnifiedChatResponse.text`（含 `streamStart` 预发）
  - `StreamUnifiedChatWithToolsIdempotent` → `response.serverChunk(BTe).response.streamUnifiedChatResponse.text` 三层包装
  - `StreamCmdK` → `response.realResponse.response.{editStart/editStream/editEnd}`（内联编辑协议，回显选区行号）或 `chat`（无选区时）
  - `reasoning_content` → `thinking.text`
- **安全降级**：wrap 异常时自动回退原通道；配置禁用时零开销透传

### CORS 说明（重要，实测结论）

Cursor 渲染进程默认启用 webSecurity（main.js 未设置 webSecurity:false），fetch 第三方 API 受浏览器 CORS 约束：

| 端点 | 实测 CORS | 结论 |
|------|-----------|------|
| `api.deepseek.com` | ✅ 动态回显 Origin，完整支持预检 | 直连可用 |
| `api.siliconflow.cn` | ✅ `Access-Control-Allow-Origin: *` | 直连可用 |
| `open.bigmodel.cn`（GLM） | ❌ OPTIONS 预检 405 | **必须走本地代理** |

GLM 用户：先运行 `node cors-proxy.js https://open.bigmodel.cn 8117`，config 的 baseUrl 填 `http://127.0.0.1:8117/api/paas/v4`（代理已实测：预检 204、转发透传、SSE 流式 pipe）。

## 三、文件清单

| 文件 | 用途 |
|------|------|
| `install.bat` / `patch.ps1` | **一键打补丁**（幂等，自动备份 + 语法校验 + 失败自动回滚 + product.json 校验和维护） |
| `restore.bat` / `restore.ps1` | **一键还原原版**（版本降级保护 + 备份完整性校验） |
| `status.bat` | 查看补丁/配置状态 |
| `test.bat` / `test-integration.js` | 28 项集成测试（mock SSE + protobuf-es v2 类型模拟，含 agent.v1 协议与工具循环 8 项） |
| `glm-proxy.bat` / `cors-proxy.js` | GLM 用户启动本地 CORS 代理 |
| `config.json` | 用户配置（API 地址/Key/模型映射/拦截列表） |
| `cm-runtime.js` | 注入到 Cursor 的运行时代码模板 |
| `cdp-e2e.js` / `stats.js` | CDP 端到端实测与运行时状态读取（开发调试用，普通用户无需） |
| `QUICKSTART.md` | 三步快速开始（中文） |

## 四、使用步骤

### 4.1 配置 API（config.json）

**DeepSeek 示例（官方现行模型 ID，旧名 `deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 停用）：**
```json
{
  "enabled": true,
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-你的真实key",
  "defaultModel": "deepseek-v4-flash",
  "modelMapping": { "*": "deepseek-v4-flash", "deepseek-v4-pro": "deepseek-v4-pro" }
}
```
> 官方可用模型（以 `GET https://api.deepseek.com/models` 实时返回为准）：`deepseek-v4-flash`（快速、便宜）、`deepseek-v4-pro`（1M 上下文、强推理）。V4 系列默认开启思考模式，回复中的 `reasoning_content` 会作为思考流显示。

**GLM 示例：**
```json
{
  "enabled": true,
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "apiKey": "你的glm-api-key",
  "defaultModel": "glm-4.6",
  "modelMapping": { "*": "glm-4.6" }
}
```

**字段说明：**
- `enabled`：总开关（false = 完全走 Cursor 原通道）
- `baseUrl`：OpenAI 兼容 API 根地址（不含 `/chat/completions`）
- `modelMapping`：Cursor UI 中选的模型名 → 实际调用的模型；`"*"` 为兜底
- `interceptMethods`：拦截的方法列表（默认含经典 Chat、Agent 幂等通道、Ctrl+K、Agents 界面）
- `blockUsageGate`：Usage 门禁拦截开关（默认 true，解除免费额度耗尽的 paused 锁定）
- `temperature` / `maxTokens`：可选采样参数
- `extraHeaders`：自定义请求头（如硅基流动等需要时）
- `sendReasoningAsText`：true 时把思维链作为正文输出（默认映射到 thinking 字段）
- `agentTools`：Agent 界面工具调用开关（默认 true，注入 `read_file`/`grep_search`/`list_dir` 三工具）
- `agentToolTimeoutMs` / `agentMaxToolRounds`：工具执行超时（默认 30000ms，超时注入占位文本不中断）与多轮上限（默认 8）
- `agentContext`：系统提示词上下文开关（`env`/`rules`/`repo`/`layout`/`mcp`，含 `layoutMaxDepth`/`layoutMaxLines`；`mcpToolSchemas` 默认 false 控制 MCP 工具 JSON Schema 是否注入）

### 4.2 打补丁
```powershell
cd <项目目录>   # 即 patch.ps1 所在目录（或直接双击 install.bat）
# 编辑 config.json 填入真实 key 后：
powershell -ExecutionPolicy Bypass -File .\patch.ps1
```

### 4.3 生效
1. **完全退出 Cursor**（右下角托盘图标 → Quit，或任务管理器结束所有 Cursor 进程）
2. 重新启动 Cursor
3. 打开任意聊天（Ctrl+L）或内联编辑（Ctrl+K）发送消息
4. 验证：开发者工具（Help → Toggle Developer Tools）Console 中出现
   `[CustomModels] runtime active → https://api.deepseek.com/v1`
   发送消息后出现 `[CustomModels] intercept aiserver.v1.ChatService/StreamUnifiedChat → deepseek-v4-flash`

### 4.4 状态检测 / 还原
```powershell
powershell -ExecutionPolicy Bypass -File .\patch.ps1 -Check   # 查看状态
powershell -ExecutionPolicy Bypass -File .\restore.ps1        # 一键还原
```

## 五、验证测试结果

### 5.1 集成测试（28/28 通过）
```
T1   runtime active                        PASS
T2   非目标 stream 透传                    PASS
T3   非目标 unary 透传                     PASS
T4   Chat直接text响应(SFt)                 PASS
T5   消息提取(角色/代码块)+模型映射         PASS
T6   Agent包装响应(BTe)+streamStart        PASS
T7   SSE轮询通道不拦截(透传)               PASS
T8   CmdK编辑协议(二级oneof,行号回显)      PASS
T9   CmdK提示词组装(query+选区+上下文)     PASS
T10  CmdK无选区→chat流                     PASS
T11  thinking→SFt.thinking                PASS
T12  上游错误抛出                          PASS
T13  禁用→原通道                           PASS
T14  close/属性透传                        PASS
T15  BiDi多包合并                          PASS
T16  Idempotent两层解包+三层响应包装       PASS
T17  stream返回结构契约(message/header/trailer) PASS
T18  提前return清理(及时终止, 子进程隔离)  PASS
T19  abort→AbortError传播(子进程隔离)      PASS
T20  usage门禁拦截(空响应)                 PASS
T20b 非门禁unary透传                       PASS
T21  agent基础流(心跳+textDelta+turnEnded单次) PASS
T22  agent thinking→thinkingDelta          PASS
T23  agent多轮记忆+system组装              PASS
T24  agent空回复兜底(turnEnded单次)        PASS
T25  agent工具调用循环(Started/Exec指令/结果回传/二轮) PASS
T26  agent工具超时降级(不中断)             PASS
T27  requestContext全量注入系统提示词      PASS
T28  嵌套requestContext(uma层)+工具不可调用声明 PASS
```

### 5.2 补丁生命周期测试（4/4 通过）
- 首次打补丁：锚点替换 + 备份 + `node --check` 语法校验通过
- 状态检测：正确识别已打/未打
- 幂等重打：自动从备份还原后重新应用
- 还原：原文件恢复，标记清零

### 5.3 人工端到端验证（需用户执行）
1. 填入真实 API key → 重新 `patch.ps1` → 重启 Cursor
2. Ctrl+L 发送 "你好" → 应收到自定义模型的流式回复
3. Ctrl+K 选中文本输入指令 → 内联编辑生效
4. 检查 Cursor 登录状态、模型列表、Tab 补全仍正常（透传未受影响）

## 六、风险评估与应对

| 风险 | 等级 | 应对 |
|------|------|------|
| Cursor 更新覆盖补丁 | 高频低危 | 更新后重跑 `patch.ps1`（幂等）；锚点变化时脚本安全退出并提示，不改文件 |
| 旧备份覆盖新版本 | 已防护 | `restore.ps1` v2.2 检测当前文件无补丁标记（即已被更新覆盖）时拒绝还原，需 `-Force` 确认；还原前后双重校验备份完整性 |
| 补丁导致语法错误 | 低危 | 脚本内置 `node --check` 校验，失败自动回滚 |
| 服务端协议变更 | 中危 | 运行时异常自动回退原通道，Cursor 不会崩溃 |
| Agent 工具调用范围 | 已知限制 | v1.5 起支持 OpenAI function calling 工具循环（`read_file`/`grep_search`/`list_dir`，由 Cursor 客户端本地真实执行）；但 Cursor 原生 UI 级 tool_call（`client_side_tool_v2_call`）与其他 MCP/内置工具不发起（已在系统提示词中向模型声明不可调用） |
| 违反 Cursor ToS | 用户须知 | 本方案仅本地修改、使用用户自有 API Key，但可能违反服务条款，风险自担 |
| API Key 安全 | — | Key 仅写入本地 config.json 并注入本地文件，不经过任何第三方 |

### 环境验证记录（第四轮审查实测）

- `MethodKind.BiDiStreaming = 3`（源码 service-type.js 枚举定义证实），runtime 的 isBidi 判断正确
- 渲染进程 CSP `connect-src 'self' http: https: ws:`（workbench.html meta 证实）——**允许任意 http/https 出站**，fetch 上游 API 与本地代理均不受 CSP 限制；`trusted-types` 仅约束 DOM 注入，不影响本方案
- main.js `webRequest.onHeadersReceived` 仅为 vscode-webview 资源防护，不拦截第三方 API 请求

### 第五轮审查修复记录（v1.2 最终）

| Bug | 严重性 | 症状 | 修复 |
|-----|--------|------|------|
| #8 stream 返回字段名错误 | 致命（隐藏） | runtime 返回 `output:`，但 Cursor `callSharedConnectStream` 消费 `for await(_.message)`（源码双证：`stream:!0,...,message:w()`）→ 拦截请求全部报错 | 改为 `message: output()`，新增 T17 契约测试 |
| #9 CmdK maxEnd 过紧 | 中 | `maxEndLineNumberExclusive=原选区行数`，模型输出更长时可能被 UI 截断 | 放宽为 +4096 行 |
| #10 回滚机制失效 | 致命（救命路径） | PS5.1 下 `node --check` 输出 stderr + `$ErrorActionPreference=Stop` → NativeCommandError 直接炸死脚本，**语法失败时自动回滚代码永远不执行**（文件留在损坏态） | node 调用临时降级 Continue，实测回滚生效 |
| #11 备份零校验 | 高 | 空/损坏的 .cm-bak 会清空主文件 | 还原前校验（>1MB 且含 `async transport(`），还原后复检 |
| #12 BOM 丢失 | 致命（工具性） | Edit 工具写 .ps1 丢 UTF-8 BOM → PS5.1 按 GBK 误读 → 11 个解析错误脚本全废 | 修复+建立规程：**凡 Edit .ps1 后必须字节级复核 BOM 与解析** |
| #13 正则分支少一个 `\}` | 致命（隐藏路径） | `$Pattern` 尾 `\)\}`（应为 `\)\}\}`）→ 只匹配147字符 → 产物多1个`}` → 语法错。因 3.16.17 走精确分支从未触发；字节拼接对照实验（合法）与 diag 注入（复现147）铁证定位 | 补全 `\}`，模拟未来版本（变量名 xY9/Zz8）全流程实测通过 |

### 第六轮审查记录（契约全量证实 + 资源清理）

- **`.message` 契约四方证实**：库工厂 `aJl`(`yield*i.message`)、`cMg`(`for await(c of s.message)`)、`callSharedConnectStream`(`_.message`)、真实 transport(`message:w()`)；全文件 204 处 `.output` 均为无关遥测属性 → Bug#8 修复对**所有**消费方正确
- **Bug #14 资源泄漏**：消费者提前 return/throw 时未取消上游 SSE reader，fetch 流后台泄漏 → `output()` 加 `try/finally` 调 `it.return()` 取消 reader；新增 T18(提前return<2s)/T19(abort→AbortError传播) 实测
- **测试框架修复**：Node24/Win http 栈对 localhost abort 连接存在 libuv 断言 bug(async.c:76)，与被测代码无关（runtime 跑在 Electron/Chromium fetch 上）→ T18/T19 移入独立端口子进程崩溃隔离，父进程按 stdout 判定；父进程 finally 补 `server.close()`（否则挂起）
- 最终：**18/18 测试通过、exit 0、606ms 干净退出**；runtime 重新部署（finally清理生效、注入恰1次）；patch/restore BOM+解析复核通过，三个 JS `node --check` 全过

> 教训：**从未被执行过的代码路径 = 未验证路径**。正则分支、回滚分支、禁用分支均需构造场景实测，"看起来对"不算数。

## 七、维护方案

- **切换模型供应商**：改 `config.json` → 重跑 `patch.ps1` → 重启 Cursor
- **临时禁用**：`enabled: false` → 重跑补丁重启（或直接 restore.ps1）
- **Cursor 升级后**：直接重跑 `patch.ps1`；若报"未找到锚点"说明新版大改，等待适配
- **卸载方案**：`restore.ps1` → 删除本项目目录

## 八、技术附录：关键逆向坐标（Cursor 3.16.17）

```
文件: %LOCALAPPDATA%\Programs\cursor\resources\app\out\vs\workbench\workbench.desktop.main.js
      workbench.glass.main.js (48MB, Cursor Agents/Glass 界面)
      api\node\extensionHostProcess.js (扩展主机 — HTTP 真正终止点)

[传输咽喉点]   async transport(){try{return await gb(this._provider,...   (desktop/glass 各一份)
[扩展主机]     registerConnectTransportProvider(n){this._provider=n,...   (真实 HTTP 终止点)
[Chat服务]     typeName:"aiserver.v1.ChatService" → StreamUnifiedChat (I:dwe O:SFt)
[请求类型]     StreamUnifiedChatRequest: conversation(1) model_details(5)
[消息类型]     ConversationMessage: text(1) type(2, HUMAN=1/AI=2) attached_code_chunks(3) tool_results(18)
[响应类型]     StreamUnifiedChatResponse: text(1) thinking(25) tool_call(13)
[BYOK残留]     ModelDetails: api_key(2) openai_api_base_url(6)
[CmdK服务]     typeName:"aiserver.v1.CmdKService" → StreamCmdK (I:vxs)
[CmdK请求]     StreamCmdKRequest: context_items(1) cmd_k_options(2) legacy_context(5)
[Agents服务]   typeName:"agent.v1.AgentService" → Run (BiDi, kind=3)
[Agents请求]   AgentClientMessage.message oneof → runRequest
               runRequest: conversation_id(1) action(2, message→Action) custom_system_prompt(3) request_context(4)
               Action.action oneof → userMessageAction → userMessage.text
[Agents响应]   AgentServerMessage.message oneof → interactionUpdate → Interaction.message oneof
               → heartbeat / thinkingDelta{text} / textDelta{text} / turnEnded{}
[Usage门禁]    DashboardService/GetUsageLimitStatusAndActiveGrants → HARD_BLOCK(resetAtMs) 锁 composer
[完整性校验]   product.json.checksums: SHA-256 base64 去填充"=" (IntegrityService)
[API主机]      Kht="https://api2.cursor.sh" (硬编码, 无环境变量覆盖)
```
