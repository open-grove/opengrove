# OpenGrove 技术参考

本文覆盖 kernel 配置、provider 设置、Bridge API、Rooms 与 ledger、数据路径、仓库结构和故障排查。入门介绍见 [README 中文版](../../README.zh-CN.md)。

## 状态

OpenGrove 仍是早期 local development project。

- package 保留了构建产物的 CLI entrypoint，但已关闭 npm 公开发布。源码
  checkout 在构建 server 后使用 `node dist/cli.js`。
- API、state files 和 adapter contracts 仍可能变化。
- Bridge 在本机运行，默认绑定 `127.0.0.1`。
- 仓库开发使用 Node.js 24 及该 Node.js 受支持版本附带的 npm。
  `packageManager` 是供会读取它的工具使用的兼容性元数据，不是 CI
  强制的精确 npm 版本。

---

## Kernels

OpenGrove 通过 `OPENGROVE_KERNEL` 选择 kernel。默认使用随桌面端内置的 Claude 内核；如需使用其他已安装内核，设置具体 kernel id。

```bash
# 默认内核
OPENGROVE_KERNEL=claude-code npm start

# 强制指定 kernel
OPENGROVE_KERNEL=codex npm start
OPENGROVE_KERNEL=claude-code npm start
OPENGROVE_KERNEL=hermes npm start
OPENGROVE_KERNEL=openclaw npm start
OPENGROVE_KERNEL=opencode npm start
```

### Kernel 详情

| Kernel | Runtime path | Provider/config boundary | Overrides |
| --- | --- | --- | --- |
| Codex | `codex app-server --listen stdio://` JSON-RPC bridge | ChatGPT 产品 Login，或 OpenGrove 中显式配置的 Provider；app-server 管理 events、approvals、dynamic tools 与 thread reuse | `OPENGROVE_CODEX_BIN` |
| Claude Agent | Anthropic Claude Agent SDK stream bridge | 原生 Claude 账号 Login，或 OpenGrove 中显式配置的 Anthropic/AWS/Vertex Provider；SDK 管理 session 与 Claude Agent 工具 | `OPENGROVE_CLAUDE_CLI_PATH` |
| Hermes | TUI Gateway over stdio JSON-RPC | Gateway events、原生 approval/question requests、原生 skill directory | `OPENGROVE_HERMES_BIN`，可选 `OPENGROVE_HERMES_TUI_GATEWAY_PYTHON` |
| Pi | Pi Agent SDK in-process | OpenGrove 把显式选择的 Provider/model 传给 `NativePiSession`；Pi 配置不会被导入 Host Provider 目录 | 可选 `PI_MODEL` |
| OpenClaw | Gateway WebSocket (`models.list`、`sessions.patch`、`chat.send`、`agent.wait`) | Gateway 中的上游按 Provider 发现；OpenClaw 保管凭据，OpenGrove 在发送前固定精确 `provider/model` | `OPENGROVE_OPENCLAW_GATEWAY_URL`、`OPENGROVE_OPENCLAW_GATEWAY_TOKEN` |
| OpenCode | ACP over stdio (`opencode acp`) | OpenGrove 传入显式选择的 Host Provider；OpenCode 自有 Provider 配置不会被导入 | `OPENGROVE_OPENCODE_BIN` |
| Kimi Code | ACP over stdio (`kimi acp`) | Kimi 产品 Login，或通过 `KIMI_MODEL_*` 注入的显式外部 Provider | `OPENGROVE_KIMI_BIN` |

### Codex 专属选项

```bash
OPENGROVE_KERNEL=codex
OPENGROVE_CODEX_MODEL=gpt-5.4
OPENGROVE_CODEX_APPROVAL_POLICY=never
OPENGROVE_CODEX_SANDBOX=danger-full-access
npm start
```

### Hermes 专属选项

```bash
OPENGROVE_KERNEL=hermes
OPENGROVE_HERMES_MODEL=your-model
OPENGROVE_HERMES_PROVIDER=your-provider
OPENGROVE_HERMES_TOOLSETS=shell,edit
# 可选：只有 OpenGrove 无法从 OPENGROVE_HERMES_BIN 推导 Hermes venv python 时才需要。
OPENGROVE_HERMES_TUI_GATEWAY_PYTHON=/path/to/hermes-agent/venv/bin/python
npm start
```

### OpenClaw Gateway 选项

```bash
OPENGROVE_KERNEL=openclaw
npm start
```

OpenGrove 会先使用显式的 `OPENGROVE_OPENCLAW_GATEWAY_URL` / `OPENGROVE_OPENCLAW_GATEWAY_TOKEN` 覆盖；如果没设置，就读取本机 `~/.openclaw/openclaw.json`，连接其中配置的本地或远端 Gateway。Bridge 会在启动、打开设置页和每六小时读取一次已配置模型目录，只保存 Provider/model 元数据；凭据继续由 OpenClaw 保管。

## Kernel 集成层

Kernel integrations 分成四层：

| Layer | Purpose |
| --- | --- |
| Transport | 拥有 wire boundary：ACP、stdio JSON-RPC、HTTP/SSE、Gateway WebSocket、PTY terminal、structured stream JSON CLI，或 SDK in-process。 |
| Event projector | 将原生事件转换成 OpenGrove events，例如 `assistant.delta`、`tool.started`、`tool.finished` 和 `approval.requested`。 |
| Kernel manifest | 记录 launch command、session strategy、provider binding、approval policy、event mapping、capabilities 和 rollout status。 |
| Harness template | 给每种协议一个 fake-server test shape，这样新增 kernel 时不用猜 runtime 行为。 |

已实现 runtime paths 包括 Codex app-server JSON-RPC、Claude Agent SDK streaming、Hermes TUI Gateway、Pi SDK in-process、OpenClaw Gateway WebSocket，以及 OpenCode/Kimi ACP。

---

## Providers

Provider setup 可以在 settings UI 或环境变量中管理。内置目录当前覆盖 WW、
Volcengine、OpenAI、Anthropic、Google Gemini、DeepSeek、OpenRouter、
AWS Bedrock、Google Vertex AI、Zhipu GLM、Kimi、Alibaba Bailian、
MiniMax、Xiaomi MiMo、AiHubMix、Azure OpenAI 和 xAI。公开模型元数据来自
内置 Models.dev snapshot 加少量 OpenGrove 连接 overlay。目录显示名相同的模型
只显示一次，但每个精确上游 wire id 仍可用于路由；Fast/Free 等不同名变体
继续分开显示。

路由身份只能是 **Login** 或 **Provider**。Login 是 Kernel 产品账号登录，
当前包括 ChatGPT/Codex、Claude Agent 和 Kimi Code。它在界面上与 Provider 分开
管理。OpenGrove 只启动 Kernel 原生 login/status/logout 命令，不复制也不保存
token。已认证 Login 只在运行时投影进模型选择器。路由优先级为 Employee
覆盖、具体模型的已保存默认、要求选择。新设置用 `$login` 表示 Login，
Provider 保存具体 id；`$native` 只用于 OpenGrove 0.6.1 升级迁移。

主 Provider 列表只包含已启用、已配置凭据或用户主动添加的服务；未激活的
内置项留在 **Add Provider**。OpenGrove 不会把 Codex、Claude、Hermes、Pi、
OpenCode 或 Kimi 的 Provider 配置扫描进该列表。OpenClaw Gateway 上游是明确的
例外，因为 Gateway 本身就是选中的 runtime 边界；它们仍是 Gateway-managed
Provider，凭据继续由 OpenClaw 保管。

Settings UI 会把 local bridge preferences 写入 OpenGrove 数据目录，通常是系统
App 数据路径下的 `bridge-settings.json`。该文件可能包含粘贴的 provider API keys、
custom provider definitions、kernel/provider bindings、App 商店 registry 设置和语音
设置。把它当作本地 secret file；共享或可复现配置优先使用环境变量。

### 环境文件加载顺序

1. `OPENGROVE_ENV_FILE`
2. `~/.opengrove/.env.local`
3. `./.env.local`
4. `./.env`

### 最小配置

```bash
OPENGROVE_KERNEL=claude-code
OPENAI_API_KEY=replace-with-your-key

# 非浏览器客户端的可选 bridge 保护。
OPENGROVE_BRIDGE_TOKEN=replace-with-local-bridge-token
OPENGROVE_BRIDGE_ALLOWED_ORIGINS=http://127.0.0.1:37371
```

浏览器扩展从 `chrome.storage.local.opengroveBridgeToken` 读取同一个 bridge token。

---

## Rooms 与 Ledger

Rooms 由 server-side `RoomChannelStore` 支持，而不是浏览器 `localStorage`。UI 从 `/rooms` 获取当前 Rooms snapshot，通过 `/rooms/events` 轮询增量变化，并把用户消息发回 bridge。权威 Room state 在 `local-state.sqlite` 中建索引，大 payload 按内容 hash 存放在 `state-blobs/`。

Local room ledger 是 room members、messages、run status 和 UI 增量事件流的事实来源。

当消息指向本地成员时，bridge 会为每个 runnable target 调度一个 room agent run，用当前消息和近期 ledger window 构造 per-member prompt，然后把最终结果写回同一个 ledger。支持 native sessions 的 kernels 仍在这个 ledger-backed prompt 后面保持 per-room-member 的原生连续性。如果 agent 需要更早的 channel context，可以用 `room.ledger.read`，传入 `roomId`、可选 `query`、`limit`、`beforeSeq` 或 `afterSeq`。工具默认只返回房间内可见消息，并通过 `sourceRoomId` 标明实际读取的权威房间；核对当前成员状态时必须显式传 `includeMembers: true`，此时只附带成员 ID、名称、状态、最近活动和停用标记，不返回完整岗位、Kernel、模型或 App 配置。账本附件永不暴露宿主机本地路径；超过 16 KiB 的内联文本或 data URL 会被省略，但仍保留附件元数据。

## App 商店

App 商店是可配置的软件包 registry。列表、archive 下载、安装、修复和 mounted App
发布都由本地 bridge 处理。安装包会解压到平台原生的 OpenGrove Programs 目录；
这条路径不包含 Connector 或 hosted runtime。

商店托管 App 使用并排的程序世代。Bridge 分别记录活动程序路径和持久化
Workspace 路径：先验证新世代，再提交挂载指针，最后尝试清理旧世代。程序在
manifest 声明的 workspace 位置保留兼容链接，因此 App 代码仍可按原相对路径访问，
但 Workspace 不再参与程序替换事务。
如果当前程序带有本地 `.git` 仓库，激活会在最终目标校验后将它复制到新世代。
因此大仓库会增加更新耗时和临时磁盘占用；Store 安装包不会提供这份本地仓库状态。

WW 鉴权成功后，bridge 使用用户 access token 读取
`GET /v1/app-store/install-policy`。响应提供 `policyKey`、
`assignmentSource` 和经授权过滤的 `apps` 数组（`packageKey`、
可选的 `minimumVersion` 和 `minHostReleaseNumber`；可安装版本仍以 Store 目录为真相源）。
bridge 不从 Role 推导该策略，也不调用 WW 的安装策略管理接口。
接口不存在、响应为空或 `apps` 为空时，本次不启用这项可选同步：不请求
Store 目录，不修改本地 App 状态，也不产生工作台故障。

可移植包可以包含可再分发源码、workspace 模板、manifest、员工、skills、hooks 和
scripts。所有打包路径都会排除 Workspace、Git 历史以及各自声明的默认/manifest 路径；
本机草稿和正式发布源码快照还会额外排除原生 session/config 目录与缓存。打包器把其余
文件内容视为不透明字节，发布者仍负责为直接 `app pack` / `app publish` 等路径排除凭据、
私有数据和机器本地配置。

---

## Bridge API

Local bridge 是 UI、state、tools 和 kernels 之间的边界。
打包桌面端可以通过登录，或选择暂不登录 OpenGrove Cloud，来完成账号引导。
这个选择是独立于账号会话的本机 UI 偏好，不会绕过桌面端的内存 Bridge token。
浏览器 session 部署仍要求账号登录，需要 Cloud 的功能也继续在各自功能边界检查登录态。

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | `GET` | Bridge 本地存活与能力摘要；不验证 WW 会话 |
| `/auth/email-codes` | `POST` | 请求 WW 邮箱验证码，并返回该邮箱是否需要注册字段 |
| `/auth/login` | `POST` | 使用邮箱验证码登录；新账号同时提交用户选择的 ISO 国家/地区，以及按需提交邀请码 |
| `/auth/session` | `GET` | 事件触发的 WW 会话恢复；区分已认证、未登录与暂时不可用 |
| `/auth/client-update` | `GET` | 当前桌面版本和适用的 Cloud 发布版本；已登录会话读取完整版本契约，未登录但通过 Bridge token 鉴权的桌面端读取公开精简版本契约 |
| `/auth/activity` | `POST` | 已登录 Electron 桌面端每天一次的最小账号活跃；不携带本地业务数据 |
| `/inventory` | `GET` | knowledge、memory、artifacts、sessions、tools、skills 和 capabilities |
| `/ask/stream` | `POST` | streaming agent turn API |
| `/approvals` | `GET` | 列出 approval requests |
| `/approvals/:id/approve` | `POST` | approve pending action |
| `/approvals/:id/reject` | `POST` | reject pending action |
| `/memory` | `GET` | 列出或搜索 memory |
| `/artifacts` | `GET` / `POST` | 列出或创建 artifacts |
| `/routines` | `GET` | 列出 routines |
| `/context-records` | `GET` | recent prompt/context diagnostics |
| `/settings` | `GET` / `PATCH` | 读取或更新本地 bridge settings |
| `/extensions` | `GET` | 扫描已挂载 skills、CLIs、MCP config、hooks、plugins 和 tool roots |
| `/extensions/skills/*` | `POST` | 为原生 kernel import、publish、republish 或 unpublish skills |
| `/app-store` | `GET` | 列出 registry 包和本地安装状态 |
| `/app-store/publish-registry` | `POST` | 发布配置 registry 支持的元数据 |
| `/app-store/publish-mounted-app/prepare` | `POST` | 依据当前本机默认值准备仅管理员可用的 mounted App 发布快照 |
| `/app-store/publish-mounted-app` | `POST` | 校验、打包并发布管理员提交的发布快照 |
| `/app-store/publish-employee` | `POST` | 打包并发布员工 |
| `/app-store/install` | `POST` | 下载并在本地安装 App 包 |
| `/app-store/repair` | `POST` | 修复本地 App 安装 |
| `/app-store/packages/:packageId/archive` | `GET` | 下载 App 商店 archive |
| `/apps/:appId/files` | `GET` | 列出 mounted App workspace files |
| `/apps/:appId/file` | `GET` / `PATCH` | 读取或更新一个 mounted App workspace file |
| `/apps/:appId/raw/*` | `GET` | 提供 mounted App raw assets/files |
| `/voice/stt/providers` | `GET` | 列出已配置的 speech-to-text providers |
| `/voice/transcriptions` | `POST` | 通过当前 STT provider 转写上传音频 |
| `/rooms` | `GET` / `POST` | 读取 room ledger snapshot 或创建 room |
| `/rooms/events` | `GET` | 按 `afterEventSeq` 轮询 room ledger events |
| `/rooms/dm` | `POST` | 打开或创建和一个 member 的 direct room |
| `/rooms/:roomId` | `PATCH` | 更新本地 room title、pin/archive state 或 badge |
| `/rooms/:roomId/read` | `POST` | 按请求体中客户端已观察的 `observedEventSeq` 单向推进 Room 已读游标 |
| `/rooms/members` | `POST` | upsert global room member |
| `/rooms/:roomId/members` | `POST` | 给 room 添加 member |
| `/rooms/:roomId/members/:memberId` | `DELETE` | 从 room 移除 member |
| `/rooms/:roomId/messages` | `GET` / `POST` | 读取 room messages，或发送用户消息并调度 room runs |
| `/rooms/:roomId/messages/:messageId` | `PATCH` | 更新本地 message status、run metadata 或 rendered parts |

当设置 `OPENGROVE_BRIDGE_TOKEN` 时，非 health endpoints 需要 `x-opengrove-token` header。

### 浏览器同步契约

浏览器先加载有界 snapshot，再用 cursor 或 revision 增量前进。Bridge 能证明数据
没变时，客户端不应重复下载完整 state。

- `/events` 在没有 cursor 时返回有界的最新 snapshot。浏览器随后只读取
  cursor 之后的 delta，已有 cursor 时才使用 25 秒 long poll，用有界分页追赶；
  Bridge 返回 `resetRequired` 时重建 snapshot。
- Rooms 先从 `/rooms` 加载 snapshot，再按 `afterEventSeq` 读取
  `/rooms/events`。空 delta 可 long-poll 25 秒；sequence 过旧或事件无法应用时，
  重新读取有界 `/rooms` snapshot。
- Context records、runs、executions、App files 和 flows 等 revision-aware 资源
  会发送 `afterRevision`；`unchanged` 响应只更新 revision，保留已有 payload。
- 只在相关 UI 启用时进行轮询；除非 query 明确需要，后台 tab 不会继续 refetch。

实现真相源是
[`use-agent-events-query.ts`](../../web/src/runtime/use-agent-events-query.ts)、
[`rooms-server-sync.ts`](../../web/src/components/rooms/rooms-server-sync.ts)
和 [`use-bridge-queries.ts`](../../web/src/runtime/use-bridge-queries.ts)。
`npm run check:web-bridge-sync` 会检查 long-poll 和聚合策略。

---

## 本地数据

OpenGrove 将可替换的商店程序、用户拥有的 App Workspace 和 Host 状态分开保存，
不要求它们共享同一个物理根目录：

| Platform | Programs | Workspaces | Host 状态根目录 |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/OpenGrove/programs/` | `~/OpenGrove/workspaces/` | `~/Library/Application Support/OpenGrove/` |
| Windows | `%LOCALAPPDATA%/OpenGrove/programs/` | `%USERPROFILE%/OpenGrove/workspaces/` | `%APPDATA%/OpenGrove/` |
| Linux | `$XDG_DATA_HOME/opengrove/programs/` 或 `~/.local/share/opengrove/programs/` | `~/OpenGrove/workspaces/` | `$XDG_CONFIG_HOME/opengrove/` 或 `~/.config/opengrove/` |

| Path | Purpose |
| --- | --- |
| `<root>/data/local-state.sqlite` | 持久化 memory、artifacts、sessions、runs、approvals、routines、events 和 server-backed room ledger 的 SQLite 索引 |
| `<root>/data/state-blobs/` | gzip 压缩、按内容寻址的大消息与工具结果 |
| `<root>/data/bridge-settings.json` | local bridge settings，包括 kernel/provider bindings、custom providers、可选 API keys、App 商店 registry 和语音设置 |
| `<root>/data/opengrove-vault/` | OpenGrove knowledge 的 file-first vault mirror |
| `<root>/data/codex-threads.json` | OpenGrove session 到 Codex thread 的 bindings |
| `<root>/data/trajectories/` | run trajectory records |
| `<workspaces>/app-id/workspace/` | 商店托管 App 的稳定持久化 Workspace |
| `<programs>/app-id/version-generation/app/` | 可替换的并排商店 App 程序世代；挂载指针选择当前活动世代 |
| `<state-root>/apps/` 与 `<state-root>/data/app-store/programs/` | 旧布局迁移来源；完整校验且健康启动后加 `.legacy-v2` 改名保留，迁移过程不删除 |
| `<root>/logs/` | 桌面端 main/bridge 日志 |

旧的仓库内 `data/` 仍然被 git ignore，但默认本地 bridge 和桌面端启动时
不会从这些旧目录导入持久化状态。源码 CLI 仍可能使用当前 checkout
的 `data/` 路径：未设置 `OPENGROVE_DATA_DIR` 时知识库会使用该路径；
诊断 capture 在未覆盖各自专用路径时也会使用它。
下列路径变量只用于选择当前运行时的存储位置。

用以下变量覆盖路径：

```bash
OPENGROVE_USER_DATA_DIR=/absolute/path/to/opengrove-user-data
OPENGROVE_DATA_DIR=/absolute/path/to/opengrove-data
OPENGROVE_STATE_PATH=/absolute/path/to/local-state.sqlite
OPENGROVE_BRIDGE_SETTINGS_PATH=/absolute/path/to/bridge-settings.json
OPENGROVE_PROGRAMS_DIR=/absolute/path/to/programs
OPENGROVE_WORKSPACES_DIR=/absolute/path/to/workspaces
```

在旧布局迁移窗口内，`OPENGROVE_APP_STORE_APPS_DIR` 继续作为
`OPENGROVE_WORKSPACES_DIR` 的兼容别名。

---

## 浏览器扩展

OpenGrove 在 `extension/` 里包含一个用于 page context 的轻量浏览器扩展。

1. 打开 Chrome 或 Edge extension management。
2. 启用 developer mode。
3. 选择 "Load unpacked"。
4. 选择本仓库的 `extension/` 目录。

该扩展会把选中的 page context 发送给 OpenGrove，但它不会直接调用 local bridge，不会持久化 page content，不会读取 password inputs，并且会跳过浏览器内部或敏感 URL surfaces。

---

## 仓库结构

```text
src/core/              稳定 event、policy、registry、store 和共享 type contracts
src/app/               OpenGrove composition root 和 app wiring
src/kernel/            Kernel contracts、discovery、tool bridge 和 adapters
src/runtime/           Codex、Claude Agent、Hermes、Pi、HTTP、generic CLI、proxy、capture、transports 和 projectors
src/server/            Local bridge、settings、kernel selection、routes、approvals、artifacts
src/rooms/             Server-backed local room ledger、members、messages 和 room events
src/knowledge/         Knowledge store views、organizer helpers、feedback 和 vault logic
src/skills/            Skill catalog、runtime 和 native publication helpers
src/tests/             Skills、kernels、runtimes 和 bridge selection 的 harness tests
src/evals/             Evaluation runner
web/                   React local UI
web/src/components/rooms/
                       Rooms、contacts、member targeting、mentions 和 room API integration
extension/             Browser context adapter
assets/brand/          Wordmark、sapling mark 和 visual system assets
```

---

## 开发

安装一次：

```bash
npm ci
```

运行检查：

```bash
npm run typecheck
npm run build
npm run smoke
npm run test:rooms
npm run test:harness
```

从源码运行桌面端：

```bash
npm start
```

该命令会先构建 server、共享 web renderer 和 Electron entrypoints，然后启动桌面壳。

显式运行浏览器 UI bridge：

```bash
npm run bridge:web
```

`bridge:web` 会构建 server 和 web assets，设置 `OPENGROVE_ENABLE_BROWSER_UI=1`，再启动 `dist/server/local-bridge.js`。

打包桌面端：

```bash
npm run pack:desktop
```

执行 `npm run build:server` 后，源码 CLI 可以启动 API bridge：

```bash
node dist/cli.js start
node dist/cli.js --version
```

---

## 设计原则

- 把 kernel-specific behavior 留在 adapters。
- 保持 host concepts 小、typed、可见。
- 优先使用显式用户上下文，而不是 ambient prompt stuffing。
- 尽量让原生 kernels 使用自己的 tools 和 skill loaders。
- Secrets 只存放在 ignored local files、environment variables 或 provider-native config。
- 高风险动作通过 policy、approvals 和 event logs 保持可见。
- UI 保持安静：collapsed tool summaries、stable status rows，不放半接线 controls。
- 交互色保持语义化：blue 表示 active/focus/action states，green 表示 OpenGrove identity 和真正成功。

---

## 安全说明

OpenGrove 在本机运行工作空间，但它仍可能连接强大的原生 agents 和 tools。应把 browser content、remote pages 和 inbound instructions 都视为不可信输入。

- Local bridge 默认绑定 `127.0.0.1`。
- 在把 bridge 暴露给任何非本地 client 前，设置 `OPENGROVE_BRIDGE_TOKEN`。
- 用 `OPENGROVE_BRIDGE_ALLOWED_ORIGINS` 限制 CORS。
- 不要提交 `.env`、`.env.local`、bridge settings 文件、provider keys、OAuth tokens、native auth files 或 capture logs。
- 凭据只存放在 ignored local files、environment variables 或
  provider-native stores。源码密钥防护由仓库和组织安全策略负责；App 打包
  不解释任意文件内容。
- 对 commands、file changes、desktop/browser actions 和 durable memory writes 认真检查 approvals。

---

## 故障排查

### 没找到 kernel

安装一个受支持的 kernel，或指定其 binary：

```bash
OPENGROVE_CODEX_BIN=/absolute/path/to/codex npm start
```

### UI 无法连接 bridge

检查 bridge 是否运行，以及浏览器 origin 是否被允许：

```bash
curl http://127.0.0.1:37371/health
```

如果设置了 `OPENGROVE_BRIDGE_TOKEN`，确保 UI 或 extension 使用同一个 token。

### Provider credentials 没被识别

把 Provider secrets 放到 `~/.opengrove/.env.local` 或 `./.env.local`，然后重启
bridge。产品 Login 凭据留在 Kernel 自己的 config directory，可以在 Settings
的 Login 区检查。打开设置页会触发 OpenClaw Gateway Provider 刷新。

### State 看起来过期

停止 bridge，把 `local-state.sqlite`、存在时的 `-wal`/`-shm` 侧车文件、`state-blobs/` 和 `bridge-settings.json` 作为一个整体备份，复制完成后再重启。OpenGrove 会重新创建缺失的 local state files。
