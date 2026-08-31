# OpenGrove 项目概览

OpenGrove 是一个面向原生编程 agent 的桌面工作空间。它为 Codex、Claude
Agent、Hermes、Pi、OpenClaw、OpenCode 和 Kimi 提供统一 host：
Rooms、员工联系人、知识文件、审批、产物、挂载 App 和诊断。

OpenGrove 不替代 kernel 的模型循环。原生 kernel 继续拥有自己的工具、会话、
认证、压缩、provider 行为和配置；OpenGrove 负责它们外层的产品与协作界面。

## 当前产品面

- **本地 UI**：React 工作空间，覆盖聊天、Rooms、联系人、知识库、设置、Apps、
  语音输入、审批和诊断。
- **桌面壳**：Electron host，负责启动本地 Bridge、注入内存 token、采集日志，并
  关闭 renderer 的 Node 权限。
- **本地 Bridge**：运行在 loopback 的 Node HTTP 服务。CLI 模式默认
  `127.0.0.1:37371`，桌面模式使用随机本地端口；负责 UI、host 状态持久化，以及把
  turn 路由到选中的 kernel。
- **Room ledger**：服务端维护的本地房间状态，记录成员、消息、mention 和 run 状态。
- **知识库**：OpenGrove 数据目录下的文件优先知识库，加上反馈、证据、修订和交付
  ledger。
- **Kernel adapters**：面向 Codex、Claude Agent、Hermes、Pi、OpenClaw、
  OpenCode 和 Kimi 的协议级桥接。
- **OpenGrove Apps**：可挂载的本地 app 根目录，可组合 skills、CLIs、workspace
  文件、provider env 需求、预览和 developer sessions。
- **App 商店**：可配置的软件包 registry；下载内容直接安装到 OpenGrove 本地数据目录。
- **浏览器扩展**：轻量网页上下文适配器，不持久化页面内容，也不直接调用 bridge。

## 部署形态

OpenGrove 只提供一个本地产品形态。

- **本地运行与数据**：`npm start` 从源码启动桌面壳；`npm run bridge:web`
  启动本机浏览器 UI 和 Bridge。聊天记录、Rooms、资料库、
  设置、App、kernel session、provider 登录态和本机 workspace 都留在用户电脑。默认
  状态写入系统 App 数据目录，不会从仓库内的旧 `data/` 目录导入
  持久化状态。

Hosted Cloud、Cloud Connector、server profile、Postgres 服务端存储、Matrix 远程房间
和 Invite Landing 不属于本仓库。

## 架构

OpenGrove 分三层职责。

| 层 | 负责 |
| --- | --- |
| Kernel | 原生推理循环、原生工具、认证、会话语义、provider 配置、压缩和 runtime 权限 |
| Host | 本地状态、Bridge API、Rooms、知识文件、审批、产物、设置、provider binding、extension inventory、诊断和事件历史 |
| Adapter | 将原生 transport/events/tools 映射成 OpenGrove events、runtime controls、knowledge sources、approvals 和 session handles |

原则很直接：在 kernel 边界保留原生能力，只规范 host 和 UI 必须理解的部分。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `src/core/` | 事件、policy、registry、store、runtime/knowledge 共享类型 |
| `src/app/` | 组合 root，连接 stores、tools、skills、packs、context 和 kernels |
| `src/kernel/` | adapter contracts、discovery、manifest、tool bridge 和 kernel adapters |
| `src/runtime/` | Codex RPC、Claude SDK/CLI、ACP、HTTP/SSE、Gateway WebSocket、Pi、generic CLI、capture、projector |
| `src/server/` | 本地 bridge、routes、settings、kernel selection、provider binding、approvals、rooms、apps、voice、preview、knowledge files |
| `src/rooms/` | 服务端 room ledger 与事件模型 |
| `src/knowledge/` | 知识 store 视图、organizer、feedback 和 vault-facing records |
| `src/skills/` | skill catalog、invocation state 和原生 skill 发布 helpers |
| `web/src/` | 本地 React UI 与浏览器侧 bridge client |
| `desktop/` | Electron main/preload、bridge supervisor、自定义协议、shell env 和诊断链路 |
| `extension/` | 浏览器页面上下文适配器 |

## 上下文与安全

OpenGrove 不应该把整个工作区塞进每次 prompt。默认 turn context 保持小：用户输入、
显式附件、显式 context chips、runtime controls 和少量相关 hint。完整文件应由原生
工具在需要时读取。

Secrets 应放在被忽略的本地文件、环境变量或原生 provider 配置里，不能写进 prompt、
event logs、workspace 文件或 tracked docs。

高风险动作需要通过 typed approvals、event logs 和 UI feedback 保持可见。Bridge
默认只绑定 `127.0.0.1`；如果暴露给非本地客户端，请先设置
`OPENGROVE_BRIDGE_TOKEN`。

## 文档

- `README.md`：安装、快速开始、功能概览和支持矩阵。
- `docs/development/BUILDING.zh-CN.md`：源码安装、桌面端与 Web 开发、
  构建产物、打包和故障排查。
- `docs/reference/TECHNICAL_REFERENCE.zh-CN.md`：kernel/provider 设置、Bridge API、数据路径、仓库结构、安全说明和故障排查。
- `docs/reference/KERNEL_INTEGRATION.zh-CN.md`：原生 Kernel adapter 契约、
  事件投影、session、tools 和 harness。
- `docs/product/OPENGROVE_APP_SPEC.zh-CN.md`：挂载 App manifest 与能力布局。
- `docs/architecture/OVERVIEW.md`：公开架构及职责边界。
- `docs/development/RELEASE_PROCESS.zh-CN.md`：桌面版本、release notes、产物门禁与发布提升流程。

长草稿、实验记录和敏感本地笔记应放在 public docs 之外，例如 `docs.local/`。
