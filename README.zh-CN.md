<p align="center">
  <img src="assets/brand/opengrove-readme-lockup.svg" alt="OpenGrove" width="360" />
</p>

<h3 align="center">把你的编程 agent 变成一支 AI 员工团队。</h3>

<p align="center">
  <a href="https://github.com/open-grove/opengrove/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/open-grove/opengrove?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-0b8ec2?style=flat-square" /></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D24-555?style=flat-square" />
  <a href="https://opengrove.io"><img alt="Website" src="https://img.shields.io/badge/web-opengrove.io-2f6f4f?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#为什么选-opengrove">为什么选 OpenGrove</a> ·
  <a href="#核心特性">特性</a> ·
  <a href="#支持的内核">内核</a> ·
  <a href="#架构">架构</a> ·
  <a href="docs/reference/TECHNICAL_REFERENCE.zh-CN.md">完整文档</a>
</p>

---

你手里已经有强大的 agent——Codex、Claude Agent、Hermes、Pi、OpenCode。但你没有的是一支团队。今天*你*是它们之间的传话人：反复粘贴上下文、复述决策、同时盯着五个终端。

OpenGrove 把它们雇进来。每个 agent 成为一名**员工**，有名字、有角色、有工作说明。你在 **Rooms** 里跟他们对话——`@` 一位 App 搭建师、拉进一位创意总监、看着他们把工作互相交接——任何高风险操作都先经你审批。装一个 **App**，你的团队就获得一整套业务能力：员工、skills、工具、工作区文件，全在一个目录里。

<p align="center">
  <img src="assets/screenshots/employees-room-en.png" alt="一个 Room：所有者向三名 AI 员工布置任务，员工之间互相规划和交接工作" width="880" />
</p>

这是 **Grove** 的开源底座——一种由一位所有者和一支 AI 员工团队运营的公司形态。OpenGrove 会把 Rooms、Apps、工作区状态和 Provider 配置保存在本机。模型请求仍会发送给你配置的内核和 Provider，部分 App 也可能使用下文说明的托管服务。

> **状态：** 活跃开发中。接口与 App 契约在版本之间仍可能调整。

## 快速开始

**下载桌面端** — 每个 [GitHub Release](https://github.com/open-grove/opengrove/releases/latest) 都附带 macOS（Apple Silicon / Intel）和 Windows x64 安装包，以及用于校验的 `SHA256SUMS.txt`。

> Windows 安装包暂未完成 Authenticode 签名，首次下载或启动时 Microsoft Defender SmartScreen 可能弹出警告。

从源码运行桌面端：

```bash
git clone https://github.com/open-grove/opengrove.git
cd opengrove
npm ci
npm start
```

如果要在同一份源码中改用本地浏览器 UI：

```bash
npm run bridge:web
```

然后打开 **http://127.0.0.1:37371/ui/**。

如果只需要本地 Bridge/API CLI：

```bash
npm run build:server
node dist/cli.js start
```

## 为什么选 OpenGrove

- **本地运行与数据。** UI、Bridge、Rooms、Apps、内核 runtime 和 Provider 配置都在你的电脑上。员工会直接处理*你的*文件，OpenGrove 不要求使用 OpenGrove 托管的 agent runtime。但你配置的内核和 Provider 仍可能把提示词与上下文发送给它们自己的服务。
- **自带 agent、自带密钥。** OpenGrove 不替代 Codex、Claude Agent 或任何内核——它把它们并排收纳，各自保留模型循环、工具和提示词规则。Provider 通过内置的 [Models.dev](https://models.dev) 目录接入，也可以添加任何兼容端点。两层都没有锁定。
- **是团队，不是终端。** Rooms 提供共享上下文、`@` 路由、消息回复和审批——多智能体协作看起来像团队配合，而不是在多个 CLI 之间复制粘贴。
- **App 让一切可组合。** OpenGrove App 是一个可移植目录，打包员工、skills、工具、MCP 配置和工作区文件。可以从商店安装、挂载、在本地定制，也可以发布你自己的。

<p align="center">
  <img src="assets/screenshots/story-seed-workspace-en.png" alt="Story Seed App：共享工作区旁边是群聊，三名员工正在推敲一份故事设计" width="880" />
  <br />
  <sub>Story Seed App：员工在群聊里推敲故事设计，旁边的共享工作区实时更新。</sub>
</p>

## 核心特性

- **多内核切换** — 在一个界面中切换 Codex、Claude Agent、Hermes、Pi、OpenClaw、OpenCode、Kimi
- **Rooms** — 私聊、群组对话、消息回复、用 `@` 将消息路由到指定员工
- **OpenGrove Apps** — 安装、挂载或发布可移植的应用目录，可打包员工、skills、CLI、MCP 配置、App 自有 MCP View、工作区文件和开发预览会话
- **App 商店与发布控制** — 带校验、回滚和发布门禁的版本化安装与更新
- **审批机制** — 文件修改、Shell 命令、高风险操作需要显式确认
- **双语界面** — 完整覆盖英文与简体中文，支持运行时热切换
- **浏览器扩展** — 将网页上下文和选区直接发送到对话中
- **Provider 自由** — 通过内置 Models.dev 目录接入主流模型服务商，或添加自己的兼容端点

## 支持的内核

| 内核 | 集成方式 |
| --- | --- |
| Codex | JSON-RPC app-server，原生事件 & 审批 |
| Claude Agent | Anthropic Agent SDK 流式输出 |
| Hermes | TUI Gateway over stdio JSON-RPC |
| Pi | SDK in-process |
| OpenClaw | Gateway WebSocket |
| OpenCode | ACP over stdio |
| Kimi CLI | ACP over stdio |

随桌面端内置的 Claude 内核是默认选择。如需使用其他已安装内核：

```bash
OPENGROVE_KERNEL=codex node dist/cli.js start
```

## 本地运行与数据

OpenGrove 的工作区 runtime 与核心数据位于本机：UI、Bridge、Rooms、Apps、
内核 runtime 和 Provider 配置都保存在这台电脑。

桌面端使用同一个本地 Bridge，由 Electron 托管启动。默认数据写入系统 App 数据目录，
Bridge 使用随机本地端口和内存 token，不会从仓库内的旧 `data/` 目录导入持久化状态。
已经位于所选 App 数据目录内的旧状态文件，会在支持时原地迁移。

App 商店安装是本地安装。Registry 可以列出可下载的 App 包，OpenGrove 会直接把包
下载并解压到本地数据目录。App 绑定的员工、`AGENTS.md`、skills、tools、hooks 和
workspace 文件都从本地安装读取，所以员工后续修改的是这台电脑上的文件。

部分 App 会把 Grove 接入真实市场——例如 Story Seed 会把真实的故事约稿路由给你的
员工。这些市场的订单审核、签约与结算运行在 OpenGrove 的托管服务上。OpenGrove
Cloud API（内部代号 **WW**）还提供账号与托管 Provider 能力；OpenGrove
Release Control 提供 App Store
目录、安装包、发布与正式版本。这些托管服务在本仓库之外运行，不接管本地工作区、原生
Kernel 会话或已安装的 App 文件。

### 后台网络访问与账号活跃上报

- **更新检查与下载**：安装版桌面端会定期向 OpenGrove Cloud 查询最新版本；启用
  自动下载时，还可能下载更新制品。已登录会话使用完整版本契约，未登录桌面端使用
  无需认证的公开端点。源码 checkout 运行的桌面端则会定期 fetch 已配置的 Git 远端，
  以检查源码更新。
- **已登录账号维护**：恢复已保存的账号会话时，Host 可能刷新令牌、读取账号资料、
  协调托管 Provider 凭据，并读取默认 App 的安装策略与目录。这些调用用于维护已登录
  账号关联的功能，不属于活跃度上报。
- **已配置集成的发现请求**：Bridge 会在启动时和每六小时刷新一次已配置 OpenAI 或
  Anthropic Provider 的模型目录，并重新发现已配置的 OpenClaw Gateway。Kernel、
  Provider 和已安装 App 还可能按各自配置及你使用的功能发出其他请求。
- **每日账号活跃**：已登录的 Electron 桌面端每个账号在每个 UTC 日最多尝试上报
  一次，且仅在窗口处于前台时发送：运行端（`desktop`）、操作系统、CPU 架构、
  客户端版本与可选发布编号、Bridge 版本与可选发布编号，以及发布渠道。不包含聊天
  内容、文件路径、工作区数据或 Provider 凭据。未登录桌面端不会发送。

账号登录、托管模型请求、App Store 操作和市场类 App 等功能会增加相应的网络请求。
Host 不会把聊天记录、Rooms、资料库或工作区文件作为后台活跃度报告上传。

## 架构

```text
┌─────────────────────────────────────┐
│  桌面壳 / React UI / 浏览器扩展       │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│  Local Bridge  (127.0.0.1:37371)    │
│  ─ rooms & 服务端 ledger            │
│  ─ 审批、产物、事件                  │
│  ─ 挂载 Apps & App 商店             │
│  ─ 员工、skills、routines           │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│  内核适配器                          │
│  Codex (JSON-RPC) · Claude (SDK)    │
│  Hermes (Gateway) · Pi (in-process) │
│  OpenClaw (WebSocket) · ACP CLIs    │
│  Structured stream JSON CLIs        │
└─────────────────────────────────────┘
```

每个内核保留自己的模型循环、工具和提示词规则。Rooms、Apps 和 OpenGrove 运行状态保存在本机。

## CLI

npm 公开发布当前已关闭。从源码 checkout 使用 CLI 时，先构建 server，
再直接运行仓库中的 CLI entrypoint：

```bash
npm run build:server
node dist/cli.js start              # 启动本地 bridge/API
node dist/cli.js app inspect <src>  # 检查 / 脚手架 / 验证 App
node dist/cli.js employee pack <id> # 打包并发布 Rooms 员工
node dist/cli.js room message create --room-id <id> --text "Hello"
node dist/cli.js room message create --room-id <id> --text "Hello" --dry-run

npm run build:web                   # 提供浏览器 UI 前必须执行
OPENGROVE_ENABLE_BROWSER_UI=1 node dist/cli.js start
```

需认证的 `web` profile 还要求配置 `OPENGROVE_WW_BASE_URL`；
详见[从源码构建](docs/development/BUILDING.zh-CN.md)。
标准 Host 命令由共享 Protocol 目录自动投影，与 Web UI 调用同一个
Client。默认输出 JSON 并连接本地 Bridge；连接其他已配置 Bridge 时，
使用 `OPENGROVE_BRIDGE_URL` 和 `OPENGROVE_BRIDGE_TOKEN`。

## 配置

创建 `~/.opengrove/.env.local` 或 `./.env.local`：

```bash
OPENGROVE_KERNEL=claude-code
OPENAI_API_KEY=sk-...
```

所有环境变量、Bridge API 端点、数据路径和高级选项请参阅[完整技术参考](docs/reference/TECHNICAL_REFERENCE.zh-CN.md)。

## 参与贡献

```bash
npm ci
npm run check        # 静态合同 + 类型 + 浏览器 UI
npm run build
npm run test:unit
npm run test:integration
npm run test:harness # 发布前完整回归
```

提交 PR 前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。CI 会执行静态检查、Node
单元测试、关键集成 smoke 与 Playwright UI 测试。

## 文档

- [技术参考](docs/reference/TECHNICAL_REFERENCE.zh-CN.md) — 内核、Provider、Bridge API、Rooms & 账本、数据路径、故障排查
- [从源码构建](docs/development/BUILDING.zh-CN.md) — 桌面端、浏览器、认证 Web、构建、打包和故障排查
- [Kernel 接入](docs/reference/KERNEL_INTEGRATION.zh-CN.md) — adapter 边界、事件映射、session、tools 和 harness
- [App 规格](docs/product/OPENGROVE_APP_SPEC.zh-CN.md) — 挂载 App manifest 和能力布局
- [架构概览](docs/architecture/OVERVIEW.md) — Host、Kernel、Adapter、Bridge 与 App 边界
- [发布流程](docs/development/RELEASE_PROCESS.zh-CN.md) — 版本、门禁安装包和发布提升
- [产品概览](PROJECT_OVERVIEW.md) — 当前产品边界和仓库结构
- [产品概览 (中文)](PROJECT_OVERVIEW.zh-CN.md)

## 许可

[Apache License 2.0](LICENSE)
