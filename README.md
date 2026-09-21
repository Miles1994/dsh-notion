# dsh-notion-mcp

通过官方 Notion MCP 服务器，用 OAuth 2.0（授权码 + PKCE）把 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（`dsh`）连接到 [Notion](https://www.notion.com)。完成一次性浏览器授权后，你的 `dsh` agent 就能通过标准的 `mcp__notion__*` 工具搜索、读取和写入 Notion 的页面、数据库与评论。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: 22.19%2B%20or%2024%2B](https://img.shields.io/badge/Node-22.19%2B%20or%2024%2B-339933.svg)](https://nodejs.org) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

中文 | [English](README.en.md)

## 它能帮你做什么

装上 `dsh-notion-mcp` 后，你的 `dsh` agent 即可直接读写 Notion。你只需要在浏览器里完成一次授权，之后**正常说话就行**——提到想操作 Notion 时插件会自动连上，用完随会话回收。插件会跑完整套 OAuth 2.0（授权码 + PKCE）流程、把 token 安全保存到 dsh 的凭据层、在会话存续期间静默刷新保持有效，并把 Notion 的搜索、页面、数据库、评论等工具以 `mcp__notion__*` 的形式挂载给 agent。

## 与「常驻挂载」的区别

完整的 Notion 工具**不会**在每个对话里凭空出现，也不会常驻占用上下文：

- **新建对话、以及没提到 Notion 的对话**：上下文里只有一个极小的连接工具 `notion_connect`（几十 token），而不是约 40 个完整 schema。
- **提到要操作 Notion 时**：插件自动挂载完整工具，范围限定在该会话自己的作用域内。
- **挂载随会话作用域回收**：会话结束（或 agent 被销毁）时连接与工具一并卸载。

这样既保留「说一句话就能用」的顺手，又彻底避免了「装了就每轮都被注入」的长期开销。

## 特性

- **关键字自动连接** —— 消息同时提到 Notion 和动作意图（查看 / 查询 / 记录 / 写入 / 待办 / 文档…）时自动挂载。
- **模型自举** —— 关键字没命中时，模型可自行调用常驻的 `notion_connect` 工具连接。
- **显式逃生通道** —— `/notion` 命令始终可用，用于强制连接或直接派发任务。
- **会话级隔离** —— 工具挂在 agent 自己的作用域，不会泄漏到其它对话。
- **零配置 OAuth** —— 动态客户端注册（RFC 7591）在运行时注册客户端，无需复制任何 `client_id` 或密钥。
- **一次性浏览器登录** —— `dsh notion login` 打印授权 URL，并在 `127.0.0.1:53007` 等待回调。
- **静默刷新 token** —— access token（约 8 小时）到期前自动刷新并重建连接；轮换后的 refresh token 原子落盘。
- **`invalid_grant` 终态处理** —— 过期或已被轮换作废的 refresh token 绝不重试；插件会清掉它并提示你重新授权。
- **仓库不含任何密钥** —— token 存在 dsh 的凭据存储里，不进入本仓库。

## 用法

**直接说话即可**，提到要操作 Notion 就会自动连接：

```text
看一下 notion 中今天的待办有哪些
分析当前架构并记录到 notion 中
把这次评审结论同步到 Notion
```

需要精确控制时，用显式命令：

```text
/notion 看一下 Notion 里的《XX 架构设计》文档，总结一下重点
/notion          # 只连接，不派发任务（之后可以直接继续对话）
```

### 关键字规则

触发条件是「**同时**出现 Notion 与动作意图」，因此下面这些只是**讨论** Notion 的消息不会误触发：

```text
notion 和飞书的区别是什么     ← 没有动作意图
看一下今天的待办              ← 没有提到 Notion
不要用 notion，直接写在本地    ← 显式否定
```

如果想让我用 Notion 却说不出动作词，模型仍可自行调用 `notion_connect` 连上。

### 为什么能「同一轮」就用上

关键点：**工具清单在模型请求之前就已经定稿**。因此插件不能简单地「检测到关键字就地挂载」——那样工具要等下一步才生效，模型会先回答「我无法访问 Notion」。

插件用两条路径规避了这个陷阱：

1. **关键字命中** → 在 `agent/pre-step` 钩子里挂载，然后把该消息重新入队并 `reject` 本次 step。`reject` 不产生模型请求（不花 token），重新入队后下一步会带着新工具重新组装。
2. **关键字未命中** → 模型调用 `notion_connect`，该调用会等到工具真正注册完成才返回，因此模型**紧接着的下一步**就能用上完整工具。

两条路径都保证「模型第一次真正尝试使用 Notion 工具时，工具一定已经就绪」。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `mcpUrl` | `https://mcp.notion.com/mcp` | Notion MCP 服务器 URL |
| `port` | `53007` | 本地 OAuth 回调端口（`127.0.0.1`） |
| `autoTrigger` | `true` | 关键字命中时自动挂载；设为 `false` 则只保留 `/notion` 与 `notion_connect` |
| `connectTool` | `true` | 是否注册常驻的 `notion_connect` 工具；设为 `false` 可做到零常驻注入 |

## 截图

让 `dsh` agent 总结一段技术架构并写入 Notion：

![dsh 里请求写入 Notion](./docs/screenshots/dsh-notion-sc1.png)

写好的 Notion 页面：

![写入后的 Notion 页面](./docs/screenshots/dsh-notion-sc2.png)

## 工作原理

```text
dsh notion login
   │  1. OAuth 发现（RFC 9470 / RFC 8414）
   │  2. 动态客户端注册（RFC 7591）
   │  3. PKCE S256 + state → 授权 URL
   ▼
浏览器批准 → 回调到 127.0.0.1:53007
   │  4. 用 code（加 PKCE verifier）换取 token
   ▼
token 落盘（此后不再自动连接）
   ⋯
对话里提到要操作 Notion（或发 /notion）
   │  5. 读取并（必要时）刷新 token
   │  6. 在该 agent 的作用域下挂载 MCP，等待工具注册完成
   │  7. 重新组装这一步的请求：此时工具已就绪
   ▼
Notion 工具以 mcp__notion__* 仅对该会话可用，随会话回收
```

`dsh notion login` 只负责完成授权并落盘 token，**不会**顺带挂载连接。真正的连接发生在对话需要 Notion 时（关键字自动、模型自举、或 `/notion` 显式触发），且挂在该 agent 自己的作用域（`agent.ctx`）下——这正是工具不会泄漏到其它对话的原因。临近过期时在会话内静默刷新，串行化以避免并发重放已轮换的 refresh token。


## 安装

```sh
dsh plugin --profile web add dsh-notion-mcp
```

把 `web` 换成你运行 agent 所用的 profile（`web`、`headless`、`tui` 等）。

## 授权

`notion` 命令需要在一个「最小 profile」里运行——像 `web` 这类 UI app 会独占自己的命令行，不会把 `notion` 转发给插件。token 是全局存储的，所以在任意最小 profile 里授权一次，所有安装了本插件的 profile 都能直接使用：

```sh
dsh plugin --profile notion add dsh-notion-mcp
dsh --profile notion notion login
```

该命令会注册一个动态 OAuth 客户端，在 `127.0.0.1:53007` 起一个临时本地 HTTP 服务，并打印授权 URL。在浏览器里打开并批准后，Notion 会重定向到 `http://127.0.0.1:53007/callback`，插件校验 `state`、用 code（加 PKCE verifier）换取 token 并落盘。

授权完成后**不会立刻挂载**。之后在对话里提到要操作 Notion（或直接发 `/notion`）时，Notion 工具才会以 `mcp__notion__*` 形式对该会话可用。

## 卸载

```sh
dsh plugin --profile web remove dsh-notion-mcp
```

## 安全性

- token 通过 dsh 的凭据层（`ctx.credentials`）以单条原子记录存储，绝不提交到本仓库；也不嵌入任何 `client_id` 或密钥——客户端在运行时通过动态客户端注册。
- Notion 每次刷新都会轮换 refresh token；新 token 与 access token 一起原子落盘。
- 若 Notion 返回 `invalid_grant`（refresh token 过期或被轮换作废），插件会清掉已存 token 并停止重试——用 `dsh notion login` 重新授权即可。

## 环境要求

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（`dsh`）—— 已验证兼容 `v0.1.0-rc.8`、`v0.1.1-rc.1`、`v0.1.1-rc.2`、`v0.1.2-alpha.1`
- Node.js `^22.19.0` 或 `>=24.0.0`（与 dsh `v0.1.2-alpha.1` 一致；Node 23 不在支持范围内）

## 开发

```sh
npm install
npm run build      # tsdown → lib/
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## 许可证

[MIT](LICENSE) © 2026 mingzeng
