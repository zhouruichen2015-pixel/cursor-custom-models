<div align="center">

# 🔌 Cursor 自定义模型直连方案

### 用自己的 API Key，让 Cursor 直连 DeepSeek / GLM / Kimi / 任意 OpenAI 兼容模型
### Agent · Cmd+K · 工具调用 · MCP 全保留，体验 100% 原生

[![version](https://img.shields.io/badge/version-1.6.1-blue?style=flat-square)](https://github.com/zhouruichen2015-pixel/cursor-custom-models/releases)
[![tests](https://img.shields.io/badge/%E9%9B%86%E6%88%90%E6%B5%8B%E8%AF%95-34%2F34_%E5%85%A8%E7%BB%BF-brightgreen?style=flat-square)](#-验证测试)
[![platform](https://img.shields.io/badge/platform-Windows-lightgrey?style=flat-square)](https://github.com/zhouruichen2015-pixel/cursor-custom-models)
[![cursor](https://img.shields.io/badge/%E5%AE%9E%E6%B5%8B-Cursor_3.16.17-orange?style=flat-square)](https://github.com/zhouruichen2015-pixel/cursor-custom-models)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![stars](https://img.shields.io/github/stars/zhouruichen2015-pixel/cursor-custom-models?style=social)](https://github.com/zhouruichen2015-pixel/cursor-custom-models/stargazers)

**如果这个项目帮你省下了订阅费，请点一个 ⭐ Star 支持作者！**

[中文仓库](https://github.com/zhouruichen2015-pixel/cursor-custom-models) | [English](https://github.com/zhouruichen2015-pixel/cursor-custom-models-en)

</div>

---

## 😫 你是不是也遇到了这些问题？

| 痛点 | 本方案的回答 |
|------|------------|
| Cursor Pro 订阅太贵，免费额度不够用 | ✅ 用**你自己的 API Key**，按量付费，便宜一个数量级 |
| 官方「自定义 API Key」不让用 Agent / Cmd+K | ✅ Agent、Cmd+K、Chat **全部可用**，和原生一模一样 |
| 网上的破解要常驻服务器 / ngrok 隧道 / 油猴脚本 | ✅ **零常驻、零隧道、零证书**，打完补丁关掉窗口就行 |
| 破解版三天两头失效，还要担心封号 | ✅ 幂等安装一键重打；不碰账号伪装，用的全是自己的 Key |
| 别的方案模型"能聊"，但读不了文件、跑不了命令 | ✅ **Cursor 原生 UI 级工具调用**：读文件、搜代码、写文件、跑终端、MCP 全真实执行 |

> **一句话原理**：在 Cursor 渲染进程内部把 5 条 AI 请求流改道到你自己的 API，其余 64 个 RPC 原样透传——不架代理、不改账号、不装证书，模型看到的项目上下文与原生完全一致（系统提示词纯透传）。

---

## ✨ 六大核心特性

| 特性 | 说明 |
|------|------|
| 🆓 **任意 OpenAI 兼容模型** | DeepSeek / GLM / Kimi / Qwen / 硅基流动聚合……填个 baseUrl 全通用，模型映射想换就换 |
| 🤖 **Agent / Chat / Cmd+K 三通道全打通** | 经典聊天 `Ctrl+L`、内联编辑 `Ctrl+K`、Agents 界面，一个不落 |
| 🔧 **真实工具调用闭环** | 8 个内置工具 + 原生 UI 级 `clientSideToolV2Call` 7 工具 + MCP 动态工具（上限 40），全部由 Cursor 客户端**本地真实执行** |
| 🎭 **系统提示词纯透传** | 不注入任何自写文案，模型看到的环境 / `.cursorrules` / 仓库 / 目录树与 Cursor 原生收集的**一字不差** |
| 🛡️ **军工级安全设计** | 自动备份 + `node --check` 语法校验 + 失败自动回滚 + product.json 校验和维护；运行异常自动降级原通道，Cursor 永不崩溃 |
| ♻️ **一键安装 / 一键还原** | 双击 `安装.bat` 生效，双击 `还原.bat` 秒回原版，幂等可反复执行 |

---

## 📊 同类方案横向对比

| | **本项目** | 试用重置类<br>(cursor-free-vip 等) | API 代理类<br>(cursor2api 家族) | 官方自定义<br>API Key |
|---|---|---|---|---|
| 无需常驻任何服务 | ✅ | ✅（脚本） | ❌ Node/Docker/隧道 | ✅ |
| 用**自己的**模型和 Key | ✅ 任意 OpenAI 兼容 | ❌ 仅 Cursor 模型 | ❌ 转售 Cursor 额度 | ⚠️ 仅 Chat |
| 原生 Agent + Cmd+K 可用 | ✅ | 仅试用 | ❌ 服务外部客户端 | ❌ Agent 被锁 |
| IDE 内真实工具调用 | ✅ 8 内置 + MCP（双通道） | ❌ | ❌ | ❌ |
| `localhost` 端点 | ✅ | 不适用 | 不适用 | ❌ 被封 |
| 无账号 / 指纹伪装 | ✅ | ❌ 机器码+临时邮箱 | ❌ 共享 Cookie | ✅ |
| 行为由测试锁定 | ✅ 34 项集成测试 | ❌ | 部分 | 不适用 |

> 调研样本：cursor-free-vip（41.7k★，临时邮箱封号问题官方 README 自认）、cursor2api（~1.8k★，需常驻服务器+风控高发）、go-cursor-help（自动更新即失效）、CurryAPI 等 cursor-api 家族（ngrok 隧道/油猴依赖）、workbench 直改方案（已归档/以阉割功能为代价）。

---

## 🚀 保姆级安装教程（全程约 5 分钟）

### 第 0 步 · 检查装备 ✅

开始前确认你已经有：

- [ ] **Windows** 系统（已实测 Cursor 3.16.17）
- [ ] 已安装 **[Node.js](https://nodejs.org)**（补丁脚本用它做语法校验，必装；装完记得重开命令行）
  - 不确定装没装？开个命令行（`Win+R` 输入 `cmd` 回车）输入 `node -v`，显示 `v20.x.x` 之类版本号就是装好了；显示"不是内部或外部命令"就没装
- [ ] 已安装 **Cursor** 并能正常打开（用的是**默认安装路径**，即装在 C 盘 `AppData` 下--绝大多数人都是）

### 第 1 步 · 下载本项目 📥

任选一种方式：

**方式 A：git clone（推荐，方便以后更新）**

```powershell
git clone https://github.com/zhouruichen2015-pixel/cursor-custom-models.git
cd cursor-custom-models
```

**方式 B：直接下载 ZIP**

1. 点击仓库右上角绿色 **`< > Code`** 按钮
2. 选择 **Download ZIP**
3. 解压到任意目录（如 `D:\cursor-custom-models`）

### 第 2 步 · 申请一个 API Key 🔑（约 2 分钟）

选一家供应商注册并充值/领取额度（都是国内直连，无需科学上网）：

| 供应商 | 控制台 | 推荐模型 | 说明 |
|--------|--------|----------|------|
| **DeepSeek**（推荐） | [platform.deepseek.com](https://platform.deepseek.com) | `deepseek-v4-flash`（快/便宜）<br>`deepseek-v4-pro`（1M 上下文/强推理） | 充值即用，价格极低 |
| **智谱 GLM** | [open.bigmodel.cn](https://open.bigmodel.cn) | `glm-4.6` | 新用户有赠送额度；⚠️ 需开本地代理（见第 3 步说明） |
| **Kimi (Moonshot)** | [platform.moonshot.cn](https://platform.moonshot.cn) | `kimi-k2` 系列 | 长上下文见长 |
| **硅基流动** | [cloud.siliconflow.cn](https://cloud.siliconflow.cn) | 多模型聚合 | 有免费额度模型，适合先试水 |

注册后在控制台的 **API Keys** 页面点「创建」，复制生成的 `sk-` 开头的 Key 备用。

### 第 3 步 · 填写配置 ⚙️（复制即用）

1. 在项目目录里,用记事本（或 VS Code）打开 `config.json`，按下面的模板修改：

**DeepSeek 用户直接抄这个（只改 apiKey 一行）：**

```json
{
  "enabled": true,
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-这里换成你自己的Key",
  "defaultModel": "deepseek-v4-flash",
  "modelMapping": { "*": "deepseek-v4-flash", "deepseek-v4-pro": "deepseek-v4-pro" }
}
```

> 💡 想用强推理模型就把三处 `deepseek-v4-flash` 都换成 `deepseek-v4-pro`。旧模型名 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，别再用。

<details>
<summary><b>📦 其他供应商配置模板（GLM / Kimi / 硅基流动，点开复制）</b></summary>

**GLM（注意：需先开本地代理，见下方说明）：**

```json
{
  "enabled": true,
  "baseUrl": "http://127.0.0.1:8117/api/paas/v4",
  "apiKey": "你的glm-api-key",
  "defaultModel": "glm-4.6",
  "modelMapping": { "*": "glm-4.6" }
}
```

**Kimi：**

```json
{
  "enabled": true,
  "baseUrl": "https://api.moonshot.cn/v1",
  "apiKey": "sk-你的kimi-key",
  "defaultModel": "kimi-k2-0905-preview",
  "modelMapping": { "*": "kimi-k2-0905-preview" }
}
```

**硅基流动（示例用 Qwen）：**

```json
{
  "enabled": true,
  "baseUrl": "https://api.siliconflow.cn/v1",
  "apiKey": "sk-你的硅基流动key",
  "defaultModel": "Qwen/Qwen3-Coder",
  "modelMapping": { "*": "Qwen/Qwen3-Coder" }
}
```

**⚠️ GLM 用户必看**：智谱官方 API 不支持浏览器 CORS 直连，需要先开本地代理：

1. 双击项目里的 **`GLM代理.bat`**（保持黑窗口开着，别关）
2. `config.json` 的 `baseUrl` 按上面模板填 `http://127.0.0.1:8117/api/paas/v4`
3. 以后每次用 GLM 前都要先开这个代理窗口

</details>

**必填字段就这 4 个，看懂就走：**

| 字段 | 填什么 |
|------|--------|
| `enabled` | `true`（总开关，`false` = 完全走 Cursor 原通道） |
| `baseUrl` | API 根地址（**不含** `/chat/completions`，抄模板即可） |
| `apiKey` | 你在第 2 步申请的 Key |
| `modelMapping` | `"*"` 兜底映射：Cursor 里随便选什么模型，实际都调用你指定的模型 |

**⚠️ 三个最高频翻车点（新手必看）：**

1. **JSON 不能写注释、不能多逗号**——`// 说明` 和结尾多余的 `,` 都会让文件非法。放心：安装脚本会先校验 JSON，非法时直接报错退出、**不会弄坏 Cursor**，改好再跑就行
2. **Key 粘贴时别带上空格或引号**——正确的 Key 是一整串以 `sk-` 开头的字符，中间无空格；占位符没换掉的话补丁会**静默不生效**（日志显示 `disabled-or-unconfigured`）
3. **保存时编码选 UTF-8**——记事本/VS Code 默认就是 UTF-8，别改成 ANSI；文件名必须是 `config.json`（别变成 `config.json.txt`，Win 默认隐藏扩展名的记得开"文件扩展名"显示）

**📌 配置什么时候生效？**你的配置是**打补丁那一刻**被写进 Cursor 的（不是运行时读取）。所以：**以后每次改完 `config.json`，都必须重跑一次 `安装.bat` + 重启 Cursor**，只重启是没用的。

<details>
<summary><b>⚙️ 高级配置全表（工具调用 / 上下文 / 采样参数等，按需展开）</b></summary>

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `interceptMethods` | 内置 5 方法 | 拦截的方法列表（经典 Chat、Agent 幂等通道、Ctrl+K、Agents 界面） |
| `blockUsageGate` | `true` | Usage 门禁拦截，解除免费额度耗尽的 "paused" 锁定 |
| `temperature` / `maxTokens` | - | 可选采样参数 |
| `extraHeaders` | - | 自定义请求头（部分供应商需要） |
| `sendReasoningAsText` | `false` | `true` 时把思维链作为正文输出（默认映射到 thinking 字段，以思考流形式展示） |
| `agentTools` | `true` | 工具调用总开关。Agent 界面注入 8 个内置工具（`read_file`/`grep_search`/`list_dir`/`write_file`/`run_terminal_cmd`/`web_fetch`/`delete_file`/`read_lints`）；Chat 界面注入 7 个原生 UI 级工具（`clientSideToolV2Call` 通道，支持 `glob_search`）；会话携带的 MCP 工具自动追加（上限 40 个） |
| `agentSystemPrompt` | `""` | 纯透传模式下**唯一**的自定义系统提示词入口，需要角色设定时填写，注入系统消息最前部 |
| `agentToolTimeoutMs` | `30000` | 工具执行超时（超时注入占位文本继续推理，不中断） |
| `agentMaxToolRounds` | `8` | 工具调用多轮上限 |
| `agentContext` | 全开 | 系统提示词上下文开关（`env`/`rules`/`repo`/`layout`/`mcp`，含 `layoutMaxDepth`/`layoutMaxLines`；`mcpToolSchemas` 默认 `false`，仅控制是否内嵌 MCP 工具 JSON Schema 全文，不影响 function calling 注入） |

</details>

### 第 4 步 · 双击安装 🛠️（10 秒）

1. **完全退出 Cursor**（右下角托盘图标右键 → Quit；不确定就开任务管理器结束所有 Cursor 进程）
2. 双击项目目录里的 **`安装.bat`**

**看到类似下面的输出就是成功了：**

```
============================================
 Cursor Custom Models - 安装补丁
============================================
[1/5] 定位 Cursor 安装目录 ............ OK
[2/5] 备份原文件 ...................... OK
[3/5] 注入运行时 ...................... OK
[4/5] node --check 语法校验 ........... OK
[5/5] product.json 校验和维护 ......... OK
补丁完成，请重启 Cursor 生效
```

<details>
<summary><b>🚑 安装报错了？点开对症下药</b></summary>

| 报错/现象 | 原因 | 解决 |
|-----------|------|------|
| `'node' 不是内部或外部命令` | 没装 Node.js 或装完没重开终端 | 去 [nodejs.org](https://nodejs.org) 装 LTS 版，重开窗口再试 |
| `未找到任何目标文件` | Cursor 装在非默认路径（如手动装到 D 盘） | 脚本默认只找 C 盘 `AppData` 下的官方默认位置；进阶用户可手动执行 `powershell -ExecutionPolicy Bypass -File .\patch.ps1 -File "完整路径\workbench.desktop.main.js"` 逐个指定（共 3 个文件），或[提 Issue](https://github.com/zhouruichen2015-pixel/cursor-custom-models/issues) |
| 双击 `.bat` 被 Windows 拦截 / 杀毒软件报警 | ZIP 下载的脚本带"网络标记"，被 SmartScreen 或杀软盯上 | 点"仍要运行"；或在文件右键 -> 属性 -> 勾"解除锁定"；给脚本目录加杀软白名单 |
| `config.json 不是合法 JSON` | 文件里有注释 / 多余逗号 / 中文引号 | 按报错行号删掉注释和多余逗号；推荐用 VS Code 打开（非法位置会有红线提示） |
| `未找到锚点` | Cursor 新版本改了代码结构 | 等待适配；期间 Cursor 不受任何影响（脚本安全退出，不改文件） |
| `补丁已存在` | 之前打过补丁 | 正常，脚本自动从备份还原后重新应用（幂等），直接继续 |
| PowerShell 执行策略报错 | 系统策略限制 | 双击 `安装.bat` 即可（内部已带 Bypass）；或手动执行 `powershell -ExecutionPolicy Bypass -File .\patch.ps1` |
| `Syntax error`（校验失败自动回滚） | 极端情况下的注入异常 | 脚本已自动还原原文件，Cursor 不受影响；请提交 Issue 附上完整输出 |

> 🙋 表里没有你的情况？[提个 Issue](https://github.com/zhouruichen2015-pixel/cursor-custom-models/issues) 把报错窗口截图发上来，比自己在网上搜半天快得多。

</details>

### 第 5 步 · 重启验证 ✨（30 秒）

1. 重新启动 Cursor
2. 按 `Ctrl+L` 打开聊天，随便发一句「你好」
3. **收到回复 = 大功告成！** 🎉 此时回复你的是你自己配置的模型

想 100% 确认走的自定义通道？两招任选：

- **看日志**：`Help -> Toggle Developer Tools` 打开控制台，Console 里应出现
  `[CustomModels] runtime active -> https://api.deepseek.com/v1`
  发消息后还会出现 `[CustomModels] intercept aiserver.v1.ChatService/StreamUnifiedChat -> deepseek-v4-flash`
- **跑测试**：双击 **`测试.bat`**，34 项集成测试应全绿（无需真实 Key）
- **双击 `状态.bat`**：随时查看补丁与配置状态

> ⚠️ 没看到 `runtime active`、Cursor 表现跟原来一模一样？九成是这两件事：**① 改完 `config.json` 忘了重跑 `安装.bat`**（配置只在打补丁时注入，重启 Cursor 没用）；**② `apiKey` 还是占位符没换成真 Key**（此时日志会显示 `disabled-or-unconfigured`）。改好 -> 重跑安装 -> 重启，三连即可。

### 日常操作速查 📋

| 想做什么 | 操作 |
|----------|------|
| 切换模型/供应商 | 改 `config.json` → 双击 `安装.bat` → 重启 Cursor |
| Cursor 更新后失效 | 重跑 `安装.bat`（幂等）即可 |
| 临时禁用 | `config.json` 改 `"enabled": false` → 重跑安装 → 重启 |
| 彻底还原原版 | 双击 `还原.bat` |
| 查看状态 | 双击 `状态.bat` |
| 跑测试 | 双击 `测试.bat`（34 项，无需真实 Key） |

---

## 🧪 它到底能干什么？（实测能力清单）

| 能力 | 状态 | 说明 |
|------|------|------|
| `Ctrl+L` 经典聊天 | ✅ | 流式回复、思考链展示（`reasoning_content` → thinking 流） |
| `Ctrl+K` 内联编辑 | ✅ | 选区行号回显，编辑协议完整 |
| Agents 界面对话 | ✅ | `agent.v1` 真实协议，多轮记忆（每会话 20 轮） |
| Agent 读文件 / 搜代码 / 列目录 | ✅ | `read_file` / `grep_search` / `list_dir`，读的是**你的真实文件** |
| Agent 写文件 / 跑终端 / 抓网页 | ✅ | `write_file` / `run_terminal_cmd` / `web_fetch` / `delete_file` / `read_lints` |
| Chat 界面原生 UI 工具卡片 | ✅ | `READ_FILE_V2` 等 7 工具走 `clientSideToolV2Call`，与官方同款 UI |
| MCP 服务器工具 | ✅ | 你在 Cursor 配的任何 MCP 工具都能被模型调用并真实执行（双通道，上限 40） |
| Usage 门禁解锁 | ✅ | "You're paused until your usage resets" 锁定解除 |
| Tab 代码补全 | ➖ | 保持 Cursor 原样（走专用补全通道，不拦截不受影响） |
| 登录 / 模型列表 / 设置 | ➖ | 64 个其他 RPC 原样透传，100% 原生 |

---

## 🧠 工作原理（技术党请进）

```
┌──────────────────────────────────────────────────────┐
│  Cursor 渲染进程（打补丁后）                            │
│                                                       │
│  Chat/CmdK/Agent 请求 ──> transport() 被包装 ──┐       │
│                                               │       │
│   5 条 AI 流 ──────────────────────────────> 拦截 ──> 你的 API（DeepSeek/GLM/…）
│   （protobuf 解码 → OpenAI messages → SSE）           │   /chat/completions
│                                                       │
│   其余 64 个 RPC ────────────────────> 原样透传 ──> api2.cursor.sh
│   （登录/模型列表/补全/设置，100% 原生）                 │
└──────────────────────────────────────────────────────┘
```

**三层封锁与突破口**（逆向结论）：

| 层级 | 官方机制 | 本方案对策 |
|------|----------|-----------|
| UI 层 | API Key 面板由服务端 `byok_enabled` 字段控制，免费账号下发 `false` | 不碰 UI，直接在传输层改道 |
| 网络层 | 所有 AI 请求强制经 `api2.cursor.sh`（ConnectRPC），主机硬编码 | 包装 `transport()` 返回值，AI 流在进程内直连你的 API |
| 数据层 | BYOK 基础设施完整保留但被隐藏（`api_key` 字段、`byokModelUtils.js` 均在） | 借用同一咽喉点，protobuf-es v2 对象直接转换 |

**拦截的 5 条流**：

| 方法 | 通道 | 说明 |
|------|------|------|
| `ChatService/StreamUnifiedChat` | 经典 Chat | ServerStreaming，直接 text 字段 |
| `ChatService/StreamUnifiedChatWithTools` | Agent | BiDi，含 streamStart 预发 |
| `ChatService/StreamUnifiedChatWithToolsIdempotent` | Agent 幂等 | BiDi，两层请求解包 + 三层响应重包装 |
| `CmdKService/StreamCmdK` | Ctrl+K | 内联编辑协议（editStart/editStream/editEnd），回显选区行号 |
| `agent.v1.AgentService/Run` | Agents 界面 | BiDi，textDelta/thinkingDelta/turnEnded + 心跳 |

> SSE 轮询通道（`...WithToolsSSE`/`...Poll`）**不拦截**——逆向证实其请求仅含 request_id 无对话内容，拦截会产生空请求。

**CORS 实测结论**（渲染进程默认启用 webSecurity）：

| 端点 | 实测 | 结论 |
|------|------|------|
| `api.deepseek.com` | ✅ 动态回显 Origin，完整支持预检 | 直连可用 |
| `api.siliconflow.cn` | ✅ `Access-Control-Allow-Origin: *` | 直连可用 |
| `open.bigmodel.cn`（GLM） | ❌ OPTIONS 预检 405 | **必须走本地代理**（`GLM代理.bat`） |

<details>
<summary><b>🔬 更多逆向细节（响应构造 / oneof 自动解析 / 安全降级）</b></summary>

- **请求转换**：protobuf-es v2 已解码对象 → OpenAI messages（角色映射 HUMAN=1/AI=2，附加代码块、工具结果；CmdK 从 `contextItems` 提取指令/选区/文件上下文）
- **响应构造**：基于 protobuf-es v2 类型内省（`fields.byMember()` / `FieldInfo.oneof` → OneofInfo 对象引用）自动解析 oneof 包装路径，任意嵌套深度可达
- **`reasoning_content` → `thinking.text`**：推理模型的思考流以原生思考展示
- **安全降级**：wrap 异常时自动回退原通道；配置 `enabled: false` 时零开销透传
- **扩展主机补丁**（extensionHostProcess.js）：包装 `registerConnectTransportProvider` 注册的真实 HTTP 传输（无竞态惰性代理）
- **product.json 校验和维护**：补丁后自动更新 SHA-256 校验和，消除 "installation appears to be corrupt" 反篡改提示
- **环境验证记录**：渲染进程 CSP `connect-src 'self' http: https: ws:` 允许任意 http/https 出站；main.js 的 `webRequest.onHeadersReceived` 仅为 vscode-webview 资源防护，不拦截第三方 API 请求

</details>

---

## 📁 文件清单

| 文件 | 用途 |
|------|------|
| `安装.bat` / `patch.ps1` | **一键打补丁**（幂等，自动备份 + 语法校验 + 失败自动回滚 + product.json 校验和维护） |
| `还原.bat` / `restore.ps1` | **一键还原原版**（版本降级保护 + 备份完整性校验） |
| `状态.bat` | 查看补丁/配置状态 |
| `测试.bat` / `test-integration.js` | 34 项集成测试（mock SSE + protobuf-es v2 类型模拟，含双通道工具循环与纯透传断言） |
| `GLM代理.bat` / `cors-proxy.js` | GLM 用户启动本地 CORS 代理 |
| `配置示例.json` → `config.json` | 用户配置（API 地址/Key/模型映射/拦截列表），**`config.json` 已被 gitignore，永不提交** |
| `cm-runtime.js` | 注入到 Cursor 的运行时代码模板 |
| `cdp-e2e.js` / `stats.js` | CDP 端到端实测与运行时状态读取（开发调试用，普通用户无需） |
| `快速入门.md` | 三步快速开始（精简版教程） |

---

## ✅ 验证测试

- **集成测试 34/34 全绿**（双击 `测试.bat` 即可复现，无需真实 Key）：覆盖 Chat/Agent/CmdK 三通道协议往返、双通道工具调用循环（含 MCP）、纯透传系统提示词断言、usage 门禁拦截、abort/return 资源清理等
- **补丁生命周期 4/4**：首次安装 / 状态检测 / 幂等重打 / 还原，全流程实测
- **人工端到端**：真实 Key 下 DeepSeek 精准回复、门禁横幅消失、完整性提示消失、多轮记忆通过

<details>
<summary><b>📋 34 项测试完整清单（点击展开）</b></summary>

```
T1   runtime active                              PASS
T2   非目标 stream 透传                          PASS
T3   非目标 unary 透传                           PASS
T4   Chat直接text响应(SFt)                       PASS
T5   消息提取(角色/代码块)+模型映射               PASS
T6   Agent包装响应(BTe)+streamStart              PASS
T7   SSE轮询通道不拦截(透传)                     PASS
T8   CmdK编辑协议(二级oneof,行号回显)            PASS
T9   CmdK提示词组装(query+选区+上下文)           PASS
T10  CmdK无选区->chat流                          PASS
T11  thinking->SFt.thinking                      PASS
T12  上游错误抛出                                PASS
T13  禁用->原通道                                PASS
T14  close/属性透传                              PASS
T15  BiDi多包合并                                PASS
T16  Idempotent两层解包+三层响应包装             PASS
T17  stream返回结构契约(message/header/trailer)  PASS
T18+T19 return清理+abort传播(子进程隔离)        PASS
T20  usage门禁拦截(空响应)                       PASS
T20b 非门禁unary透传                             PASS
T21  agent基础流(心跳+textDelta+turnEnded单次)   PASS
T22  agent thinking->thinkingDelta               PASS
T23  agent多轮记忆+system组装                    PASS
T24  agent空回复兜底(turnEnded单次)              PASS
T25  agent工具调用循环(Started/Exec指令/结果回传/二轮) PASS
T26  agent工具超时降级(不中断)                   PASS
T27  requestContext全量注入系统提示词            PASS
T28  嵌套requestContext(uma层)+纯透传系统提示词  PASS
T29  Chat工具循环(clientSideToolV2Call往返)      PASS
T30  Idempotent三层包装工具调用                  PASS
T31  agent write_file(UI/exec双字段名)           PASS
T32  agent MCP工具(mcpArgs map Value.wrap)       PASS
T33  Chat MCP工具(CALL_MCP_TOOL+Struct)          PASS
T34  agentSystemPrompt配置注入(纯透传入口)       PASS
```

</details>

---

## ❓ FAQ

**Q: 会被 Cursor 封号吗？**
本方案不碰账号伪装、不用临时邮箱、不共享 Cookie——就是在你自己电脑上用自己的 Key。但本地修改客户端**可能违反服务条款**，风险自担（详见下方风险表）。

**Q: 我的 API Key 安全吗？**
Key 只写入本地 `config.json`（已被 `.gitignore` 排除，永不提交），注入的也是本地文件，**不经过任何第三方服务器**。

**Q: Tab 补全也换成自定义模型了吗？**
没有。Tab 走专用补全通道（未拦截），保持 Cursor 原样——所以登录、模型列表、Tab 补全全都不受影响。

**Q: 支持 Mac / Linux 吗？**
当前仅支持 Windows（补丁脚本是 PowerShell）。实测 Cursor 3.16.17。

**Q: 报 401 / 余额不足 / 模型不存在？**
检查 `config.json` 的 `apiKey` 是否复制完整（无多余空格）、账户是否有余额、`defaultModel` 模型 ID 是否为供应商现行 ID。

**Q: Cursor 更新后又变回原版了？**
正常，更新会覆盖补丁文件。重新双击 `安装.bat` 即可（幂等）。若提示「未找到锚点」说明新版大改，[提个 Issue 催适配](https://github.com/zhouruichen2015-pixel/cursor-custom-models/issues)（附上 Cursor 版本号，通常很快跟进）。

**Q: GLM 为什么还要开代理？**
智谱官方 API 不允许浏览器直连（CORS 预检 405）。双击 `GLM代理.bat` 开本地代理即可，DeepSeek / 硅基流动 / Kimi 均可直连无需代理。

**Q: 改了 `config.json`（换模型 / 换供应商）为什么没生效？**
配置是**打补丁那一刻**写进 Cursor 的，不是运行时读取。正确姿势：改完配置 -> 重跑 `安装.bat` -> 重启 Cursor，一步都不能少。

**Q: Cursor 装在 D 盘 / 自定义路径，脚本报"未找到任何目标文件"？**
脚本默认只找官方默认位置（C 盘 `AppData`）。进阶用户可手动执行 `powershell -ExecutionPolicy Bypass -File .\patch.ps1 -File "你的路径\workbench.desktop.main.js"` 逐个指定目标文件；也欢迎提 Issue。

**Q: 怎么确认当前对话用的是哪个模型？**
开 DevTools 控制台看 `[CustomModels] intercept ... -> 模型名` 日志，或双击 `状态.bat` 查看补丁与配置状态。

**Q: API Key 万一泄露了怎么办？**
`config.json` 已被 gitignore 且不经过任何第三方，正常使用不会泄露。如果不放心/确认泄露：立刻去供应商控制台**删除旧 Key 重新生成一个**，改好 `config.json` 重跑 `安装.bat` 即可，供应商侧一键止损。

**Q: 怎么彻底卸载？**
双击 `还原.bat`（自动恢复原文件 + 修复 product.json 校验和），然后删除整个项目文件夹。追求干净的还可以删掉 Cursor 安装目录下残留的 `*.js.cm-bak` 备份文件（在 `resources\app\out` 里，不删也无任何影响）。

**Q: 遇到的问题上面没写到？**
别自己憋着，[直接提 Issue](https://github.com/zhouruichen2015-pixel/cursor-custom-models/issues)，附上三样东西能让你更快得到回复：
1. `安装.bat` / `还原.bat` 窗口的**完整输出**（截图即可）
2. Cursor 版本号（`Help -> About` 里看）
3. DevTools Console 里的 `[CustomModels]` 相关日志（有就贴上）

---

## ⚠️ 风险须知

| 风险 | 等级 | 应对 |
|------|------|------|
| Cursor 更新覆盖补丁 | 高频低危 | 重跑 `安装.bat`（幂等）；锚点变化时脚本安全退出不改文件 |
| 旧备份覆盖新版本 | 已防护 | `restore.ps1` 检测到当前文件无补丁标记时拒绝还原（需 `-Force` 确认）；还原前后双重校验备份完整性 |
| 补丁导致语法错误 | 低危 | 内置 `node --check` 校验，失败自动回滚 |
| 服务端协议变更 | 中危 | 运行时异常自动回退原通道，Cursor 不会崩溃 |
| 违反 Cursor ToS | 用户须知 | 仅本地修改、使用自有 API Key，但可能违反服务条款，风险自担 |
| API Key 安全 | - | 仅写入本地 `config.json`，不经过任何第三方 |

---

## 📜 更新历史

<details>
<summary><b>v1.6.1 · 系统提示词纯透传（当前版本）—— 点击展开全部历史</b></summary>

**v1.6.1：系统提示词纯透传（只有模型走自定义）**
- 删除全部运行时自写文案：自造角色提示词（"You are an AI coding agent..."）、工具可调用 Note 声明、行为性标题后缀全部移除
- 系统消息仅由 **Cursor 客户端收集的原文数据**组成：环境信息、`.cursorrules` 规则原文、仓库信息、项目目录树、MCP 指令与工具描述，外加请求内 `customSystemPrompt` 原文——一字不改
- 无任何上下文时不发送 system 消息（只发对话本身）
- 新增 `agentSystemPrompt` 配置（默认空）：纯透传模式下唯一自定义入口
- 集成测试 34/34 通过（T21/T28 断言更新为纯透传，新增 T34）

**v1.6.0：全部工具通道打通（33/33）**
- Chat 界面原生 UI 级工具循环（`clientSideToolV2Call`）：`READ_FILE_V2`/`RIPGREP_SEARCH`/`LIST_DIR_V2`/`GLOB_FILE_SEARCH`/`RUN_TERMINAL_COMMAND_V2`/`DELETE_FILE`/`WEB_FETCH`，Cursor 以官方同款 UI 展示并本地真实执行
- Agent 通道扩展至 8 内置工具：新增 `write_file`/`run_terminal_cmd`/`web_fetch`/`delete_file`/`read_lints`
- MCP 动态工具双通道：会话携带的 MCP 工具自动转为 function schema 注入（上限 40 个），Agent 走 `mcpToolCall`/`mcpArgs`，Chat 走 `CALL_MCP_TOOL`
- Idempotent 通道 `clientChunk`/`vectorEmbryo` 三层包装自动解包/重包装

**v1.5.1：requestContext 读取位置修正（协议 dump 实证）**
- 发现 3.16.17 的 Agent Run 请求中 `requestContext` 嵌在 `action.userMessageAction.requestContext`（而非顶层），双位置兼容读取后 E2E 实测 `sysLen` 269 → 7,832
- MCP 工具 schema 默认不注入（防提示词爆炸），新增 `agentContext.mcpToolSchemas` 配置
- 新增 `stats.agentDebug.rcFrom` 诊断字段

**v1.5.0：requestContext 全量注入 + Agent 工具调用循环**
- 环境信息（OS/Shell/工作目录/时区）、`.cursorrules` 全文、Git 仓库信息、项目目录树、MCP 指令与工具 schema 全量进入系统提示词
- Agent 工具调用三段式协议：`toolCallStarted -> execServerMessage -> execClientMessage -> toolCallCompleted`，实测 5 秒读取真实文件并正确回答
- 工具执行超时自动降级（30s）+ 多轮上限（8 轮可配）

**v1.4 / v1.4.1：Agents 界面 + Usage 门禁 + 扩展主机**
- 新增 Cursor Agents 界面支持（`agent.v1.AgentService/Run`）
- Usage 门禁拦截：彻底解除 "You're paused until your usage resets" 锁定
- 扩展主机补丁（extensionHostProcess.js）+ product.json 校验和维护（消除反篡改提示）
- 多轮对话记忆（每会话 20 轮，最多 64 会话）；agent 空回复兜底去重
- `restore.ps1` 备份完整性校验；全部 `.bat` LF→CRLF；`stats.js` 去 `ws` 依赖

</details>

---

## 📚 技术附录

<details>
<summary><b>关键逆向坐标（Cursor 3.16.17，点击展开）</b></summary>

```
文件: %LOCALAPPDATA%\Programs\cursor\resources\app\out\vs\workbench\workbench.desktop.main.js
      workbench.glass.main.js (48MB, Cursor Agents/Glass 界面)
      api\node\extensionHostProcess.js (扩展主机 - HTTP 真正终止点)

[传输咽喉点]   async transport(){try{return await gb(this._provider,...   (desktop/glass 各一份)
[扩展主机]     registerConnectTransportProvider(n){this._provider=n,...   (真实 HTTP 终止点)
[Chat服务]     typeName:"aiserver.v1.ChatService" -> StreamUnifiedChat (I:dwe O:SFt)
[请求类型]     StreamUnifiedChatRequest: conversation(1) model_details(5)
[消息类型]     ConversationMessage: text(1) type(2, HUMAN=1/AI=2) attached_code_chunks(3) tool_results(18)
[响应类型]     StreamUnifiedChatResponse: text(1) thinking(25) tool_call(13)
[BYOK残留]     ModelDetails: api_key(2) openai_api_base_url(6)
[CmdK服务]     typeName:"aiserver.v1.CmdKService" -> StreamCmdK (I:vxs)
[CmdK请求]     StreamCmdKRequest: context_items(1) cmd_k_options(2) legacy_context(5)
[Agents服务]   typeName:"agent.v1.AgentService" -> Run (BiDi, kind=3)
[Agents请求]   AgentClientMessage.message oneof -> runRequest
               runRequest: conversation_id(1) action(2, message->Action) custom_system_prompt(3) request_context(4)
               Action.action oneof -> userMessageAction -> userMessage.text
[Agents响应]   AgentServerMessage.message oneof -> interactionUpdate -> Interaction.message oneof
               -> heartbeat / thinkingDelta{text} / textDelta{text} / turnEnded{}
[Usage门禁]    DashboardService/GetUsageLimitStatusAndActiveGrants -> HARD_BLOCK(resetAtMs) 锁 composer
[完整性校验]   product.json.checksums: SHA-256 base64 去填充"=" (IntegrityService)
[API主机]      Kht="https://api2.cursor.sh" (硬编码, 无环境变量覆盖)
```

</details>

<details>
<summary><b>质量审查记录（五轮 bug 追杀，点击展开）</b></summary>

历经六轮代码审查，修复的全部关键 bug：

| Bug | 严重性 | 症状与修复 |
|-----|--------|-----------|
| #8 stream 返回字段名错误 | 致命（隐藏） | runtime 返回 `output:` 但 Cursor 消费 `.message` → 拦截请求全报错；改为 `message: output()` 并新增 T17 契约测试，`.message` 契约四方源码证实 |
| #10 回滚机制失效 | 致命（救命路径） | PS5.1 下 `node --check` 的 stderr 触发 NativeCommandError 炸死脚本，语法失败时回滚永不执行；node 调用临时降级 Continue |
| #11 备份零校验 | 高 | 空/损坏备份会清空主文件；还原前校验（>1MB 且含 `async transport(`） |
| #13 正则分支少 `\}` | 致命（隐藏路径） | 产物多 1 个 `}` 导致语法错；字节拼接对照实验 + diag 注入铁证定位 |
| #14 资源泄漏 | 中 | 消费者提前 return 时上游 SSE reader 泄漏；`output()` 加 `try/finally` 调 `it.return()`，新增 T18/T19 实测 |

> 教训：**从未被执行过的代码路径 = 未验证路径**。正则分支、回滚分支、禁用分支均构造场景实测，"看起来对"不算数。

</details>

---

<div align="center">

## 🌟 觉得好用？

**点个 Star** 是对作者最大的支持，也让更多人看到这个项目！

[![stars](https://img.shields.io/github/stars/zhouruichen2015-pixel/cursor-custom-models?style=for-the-badge)](https://github.com/zhouruichen2015-pixel/cursor-custom-models/stargazers)

遇到问题？[提个 Issue](https://github.com/zhouruichen2015-pixel/cursor-custom-models/issues)（🐛 报 Bug · 🔧 Cursor 新版没适配 · 💡 想要的功能建议，来者不拒） · 想看英文版？[English README](https://github.com/zhouruichen2015-pixel/cursor-custom-models-en)

**仅限学习研究使用 · 风险自担 · [MIT License](LICENSE)**

</div>
