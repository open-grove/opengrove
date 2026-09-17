# 从源码构建 OpenGrove

[CI 职责与配置](CI.zh-CN.md)

本文覆盖源码安装、Desktop 与 Web 启动、编译、本地打包和验证。
所有命令均在仓库根目录执行。先按目标选择入口，再阅读对应流程；
正式桌面发布使用独立的[发布流程](RELEASE_PROCESS.zh-CN.md)。

## 环境要求

- Node.js 24（CI 使用的版本系列；`package.json` 要求 `>=24`）。
- 随受支持的 Node.js 24 版本附带的 npm。
- macOS、Windows 或 Linux；桌面安装包在对应操作系统上构建。
- Web 归档的创建和检查要求 `tar` 在 `PATH` 中可用。

`packageManager` 字段为会读取它的工具记录一个兼容的 npm 版本；
仓库和 CI 不要求必须使用该精确版本。按 lockfile 安装依赖：

```bash
git clone https://github.com/open-grove/opengrove.git
cd opengrove
npm ci
```

当前 package 关闭了 npm 公开发布。源码 checkout 应在构建后使用
`node dist/cli.js ...`，不要假设系统中已安装全局 `opengrove` 命令。
仅使用 API 需要 `build:server`；提供浏览器 UI 还需要 `build:web`。

下文行内环境变量与 `export` 示例适用于 Bash/Zsh。PowerShell 使用
`$env:变量名 = "值"`，例如：

```powershell
$env:OPENGROVE_WW_BASE_URL = "https://accounts.example.test"
npm run dev:web
```

文中的服务地址是占位符，运行前替换为有权使用的环境地址。

## 按目标选择命令

| 目标 | 命令 | 结果与成功检查 |
| --- | --- | --- |
| 开发 Desktop | `npm start` 或 `npm run desktop:dev` | 完整构建后打开 OpenGrove Dev，确认界面加载完成 |
| 重建并重启 Desktop 开发实例 | `npm run restart:desktop-dev` | 停止开发进程、构建、启动并探测 Bridge，成功后打印地址与 PID |
| 联调认证 Web | `npm run dev:web` | 先配置 WW 地址；Vite UI 默认在 `5173/ui/`，Bridge 在 `37371` |
| 运行构建后的认证 Web | `npm run start:web` | 先配置 WW 地址；同一个 Bridge 提供 `37371/ui/` 和 API |
| 本地 Bridge 浏览器 UI | `npm run bridge:web` | 完整构建后提供 `37371/ui/`；认证由环境配置决定 |
| 只编译源码 | `npm run build` | 生成 `dist/`、`web-dist/`、`desktop-dist/`，不启动应用 |
| 检查打包后的 Desktop | `npm run pack:desktop` | 生成并校验 `release/desktop/` 下的应用目录，不生成安装器 |
| 制作当前平台安装包 | `npm run dist:desktop` | 生成安装包与应用目录，并完成脚本自带的产物校验 |
| 制作 Web 后端归档 | `npm run pack:web:backend` | 生成并校验 `release/web/opengrove-<version>.tgz` |
| 制作 Web 前端归档 | `npm run pack:web:frontend` | 生成并校验 `release/web/opengrove-web-<version>.tar.gz` |

`build` 是编译，`pack` 是应用目录或部署归档，`dist:desktop` 是桌面安装包。
编译成功不能代替启动验证，生成本地安装包也不表示完成正式发布。

Desktop 通过 Electron 的 `app.isPackaged` 判定运行通道：源码启动是 `dev`，
打包后的应用是 `stable`。这些名字不是 Git 分支名；本地打包产物也使用
`stable` 通道。Web 没有独立的 `stable` 配置开关，本文使用“Vite 开发”与
“构建后运行”区分两种方式。

## Desktop 开发

```bash
npm run desktop:dev
```

`npm start` 是同一入口。命令先执行完整构建，再通过开发启动器运行
Electron。它没有源码热更新；修改后使用以下命令重建并重启：

```bash
npm run restart:desktop-dev
```

重启脚本会探测新 Bridge 和构建时间；出现 `OpenGrove Dev restarted`、
Bridge 地址与 PID 后，再确认窗口里的界面可用。不要把 Electron 进程
出现或编译结束当作应用已就绪。

默认开发通道与打包通道使用独立的应用身份、单实例锁和数据目录：

| 项目 | Desktop dev | 打包后的 Desktop |
| --- | --- | --- |
| 应用名 | OpenGrove Dev | OpenGrove |
| macOS / Windows app-data 目录名 | `OpenGroveDev` | `OpenGrove` |
| Linux app-data 目录名 | `opengrove-dev` | `opengrove` |

本地 `pack:desktop` 产物默认也使用打包通道的数据目录。验证该产物时，
应先退出已有的 OpenGrove 安装版。

需要隔离测试服务与数据时，在根目录 `.env.local` 配置
`.env.local.example` 中的 `OPENGROVE_DESKTOP_DEV_TEST_WW_BASE_URL` 和
`OPENGROVE_DESKTOP_DEV_TEST_RELEASE_CONTROL_URL`，再执行：

```bash
npm run restart:desktop-dev:test
```

这个入口读取 `.env.local`，使用 `test` profile，并隔离到
`OpenGroveDev-test`（Linux 为 `opengrove-dev-test`）。两个服务地址都必须
配置；具体配置边界见[配置](../reference/CONFIGURATION.md)。

## Web 开发与运行

`web` 命令强制启用浏览器 UI 和 WW session 认证，缺少
`OPENGROVE_WW_BASE_URL` 时拒绝启动。WW 是 OpenGrove Cloud API，负责账号
session；本地 Bridge 继续管理 Workspace、Room、App、SQLite 状态和本机
Kernel 进程。该运行形态为单 Principal，不提供多租户或容器隔离。

### 联合开发

```bash
OPENGROVE_WW_BASE_URL=https://accounts.example.test npm run dev:web
```

打开 `http://127.0.0.1:5173/ui/`。启动器先构建后端，再同时启动
`node dist/cli.js web` 与 Vite。Vite 提供前端热更新，Web Build ID 为 `dev`。
后端监听 `src/` 与 `packages/agent-protocol/src/` 内的 TypeScript/JSON
变化，重建成功后重启 Bridge；其他共享包或构建配置变化后应重启联合入口。
任一服务意外退出时，启动器会关闭其余子进程。

需要分别查看日志时，在两个终端运行：

```bash
# 终端 1：构建并启动后端；此入口不监听源码变化。
OPENGROVE_WW_BASE_URL=https://accounts.example.test npm run dev:web-backend
```

```bash
# 终端 2：启动 Vite。
npm run dev:web-frontend
```

Vite 默认把 `/api`、`/generated`、`/vault-file`、`/apps`、
`/mcp-app-sandbox` 和 `/mcp-app-media` 代理到 `http://127.0.0.1:37371`。
自定义后端端口时，两个终端的配置要对应：

```bash
# 终端 1
OPENGROVE_WW_BASE_URL=https://accounts.example.test OPENGROVE_BRIDGE_PORT=37420 npm run dev:web-backend
```

```bash
# 终端 2
OPENGROVE_WEB_DEV_BACKEND_URL=http://127.0.0.1:37420 npm run dev:web-frontend
```

前端监听地址由 `OPENGROVE_WEB_DEV_FRONTEND_HOST`（默认 `127.0.0.1`）和
`OPENGROVE_WEB_DEV_FRONTEND_PORT`（默认 `5173`）控制。端口被占用时会报错，
不会自动换端口。联合启动使用自定义后端端口时，也要设置对应的代理地址。

### 构建后运行

```bash
OPENGROVE_WW_BASE_URL=https://accounts.example.test npm run start:web
```

命令依次运行 `build:server`、`build:web` 和 `node dist/cli.js web`。
打开 `http://127.0.0.1:37371/ui/`；Bridge 直接托管 `web-dist/` 与 API，
没有 Vite 或热更新。已有匹配的后端、前端构建时，可以直接启动：

```bash
OPENGROVE_WW_BASE_URL=https://accounts.example.test node dist/cli.js web
```

在另一个终端检查（使用自定义端口时相应替换）：

```bash
curl --fail http://127.0.0.1:37371/api/bootstrap
curl --fail http://127.0.0.1:37371/api/auth/session
curl --fail http://127.0.0.1:37371/version.json
```

Bootstrap 应包含 `environment.preset: "web-single"` 和
`auth.mode: "session"`；新浏览器会话未登录时 Session 返回
`status: "unauthenticated"`。`version.json` 的 `packageVersion` 应与本次
构建的根 `package.json` 一致。再打开 UI 检查资源加载，并使用目标环境
账号验证登录；上述本地响应不代表远端登录已经成功。

### 本地 Bridge/API

已有后端构建时，直接运行本地 profile：

```bash
node dist/cli.js start
```

`start` 与 `bridge` 是同义命令。此入口默认不提供浏览器 UI；从源码构建
并启用浏览器 UI 使用 `npm run bridge:web`。已有后端和前端构建时也可执行：

```bash
OPENGROVE_ENABLE_BROWSER_UI=1 node dist/cli.js start
```

本地 profile 不强制指定认证模式：显式 `OPENGROVE_WEB_AUTH_MODE` 优先；
未指定时，配置了 WW 地址会选择 session，否则选择 bridge-token。
需要明确使用本地 Token 模式时，执行
`OPENGROVE_WEB_AUTH_MODE=bridge-token npm run bridge:web`，并按需要配置
`OPENGROVE_BRIDGE_TOKEN`。`web` profile 则始终强制 session。

## 只编译源码

| 命令 | 构建范围与主要输出 |
| --- | --- |
| `npm run build:server` | 重建 Protocol、Agent Protocol、Client 与后端；生成 `dist/` 和对应共享包的 `dist/` |
| `npm run build:web` | 构建 `web-dist/`，并检查资源引用与开发测试账号边界 |
| `npm run build:desktop` | 构建 `desktop-dist/main.cjs` 与 `desktop-dist/preload.cjs` |
| `npm run build` | 先构建后端及共享包，再并行构建 Web 和 Electron 入口 |

这些命令都不启动应用。单独 `build:desktop` 不会补建后端和 Web，只有依赖
产物已存在且与源码一致时才适合使用。构建会清理对应输出目录；不要在同一
checkout 同时执行独立的构建、打包任务。

Web 构建使用相对资源根 `./`，把包版本与 Build ID 写入 `index.html` 和
`version.json`。以下变量在构建时读取：

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OPENGROVE_WEB_API_BASE` | `../api/` | 写入前端的 API Base |
| `OPENGROVE_WEB_BUILD_ID` | 当前毫秒时间的 base36 字符串 | 覆盖非 Vite 开发构建的 Build ID |
| `OPENGROVE_WEB_SOURCEMAP` | 关闭 | 设为 `1` 生成 Web Source Map |
| `OPENGROVE_DESKTOP_SOURCEMAP` | 关闭 | 设为 `1` 生成 Electron Source Map |

改变这些变量后需要重建对应产物，单纯重启 Bridge 不会修改已构建的前端。

## Desktop 本地打包

```bash
npm run pack:desktop
```

这条命令执行完整构建、压缩 `dist/`、准备当前平台/架构的内置 Claude
Engine、检查打包输入、生成应用目录，最后运行产物校验。需要安装器时使用：

```bash
npm run dist:desktop
```

默认输出都在 `release/desktop/`：

| 平台 | 应用目录 | `dist:desktop` 额外生成 |
| --- | --- | --- |
| macOS | `mac-arm64/OpenGrove.app`；x64 为 `mac/OpenGrove.app` 或 `mac-x64/OpenGrove.app` | DMG、ZIP |
| Windows | `win-unpacked/` | NSIS EXE |
| Linux | `linux-unpacked/` 或 `linux-<arch>-unpacked/` | AppImage |

应用目录表示 electron-builder 的目录产物，其内部仍使用 ASAR 打包。
两条命令都会检查包清单和 Engine；对当前机器可执行的目标，还会实际探测
打包后的 Bridge 并运行 Engine 的 `--version`。命令成功后打开对应应用，
确认界面和 Bridge 正常；制作安装器后还应验证实际安装与启动。

本地配置 `electron-builder.yml` 设置 `opengroveOfficialRelease: false`。
macOS 本地包使用 ad-hoc 签名，未启用正式公证；这些产物用于内部验证。

### 多架构产物

在对应操作系统上运行：

```bash
npm run dist:desktop:mac
```

生成 macOS arm64 与 x64 产物，并对两个目标调用产物检查。

```bash
npm run dist:desktop:linux
npm run check:desktop-artifact -- --target linux-x64 --target linux-arm64
```

Linux 命令生成 x64 与 arm64 产物，但不自动调用最终产物检查，因此显式
补上第二条命令。跨架构检查默认只校验包内容，不能代替目标机器上的运行
验证。macOS arm64 上仅在具备 x64 执行环境且设置
`OPENGROVE_CHECK_TRANSLATED_ENGINES=1` 时，检查器才执行 x64 目标。
Windows 当前正式发布目标为 x64，使用 Windows 上的 `dist:desktop`。

### 正式桌面发布

`dist:desktop:release` 是平台发布构建链的底层入口，不等于完整发布。
候选版本由受信 CI 构建，必须通过安装、启动、更新、制品身份和各平台
门禁；macOS 还需签名与公证，再进入 finalize、登记与显式 promote 流程。

`release:readiness` 是候选 workflow 的发布就绪检查；`release:check` 是可选
的更广本地检查。二者都不能代替 CI 门禁。候选要求、凭据与完整操作以
[发布流程](RELEASE_PROCESS.zh-CN.md)为准。

## Web 部署归档

```bash
npm run pack:web:backend
npm run pack:web:frontend
```

两条命令分别执行，按所需产物选择：

| 归档 | 构建与内容 |
| --- | --- |
| `release/web/opengrove-<version>.tgz` | 先完整 `build`，验证 Web 产物，再以 `npm pack --ignore-scripts` 打包；包含 `package/package.json`、`package/dist/cli.js` 和 `package/web-dist/` |
| `release/web/opengrove-web-<version>.tar.gz` | 先 `build:web`；归档根目录包含 `index.html`、`version.json` 和 `assets/`，没有额外的 `web-dist/` 层 |

后端 npm 包已包含前端资源；只需同一 Bridge 提供 UI 时，无需另取前端
归档。独立前端归档仅包含静态文件，不包含 Bridge/API。分别构建的两个
归档 Build ID 可以不同；包版本取自根 `package.json`。

两条命令都会先暂存并校验归档，再替换同版本目标文件，成功时打印
`Created`、大小和 SHA-256。构建或校验失败不会替换已有归档，但仓库内
构建目录可能已经更新。输出目录可定制：

```bash
npm run pack:web:backend -- --output-dir ../artifacts
npm run pack:web:frontend -- --output-dir ../artifacts
```

相对路径以仓库根目录为基准，也可使用绝对路径；输出不能位于 `dist/`、
`web-dist/`、`desktop-dist/` 或它们的子目录。查看当前版本归档结构：

```bash
version=$(node -p "require('./package.json').version")
tar -tzf "release/web/opengrove-${version}.tgz"
tar -tzf "release/web/opengrove-web-${version}.tar.gz"
```

## 运行配置与状态隔离

### 环境变量

CLI 的 `--host`、`--port` 优先于 `OPENGROVE_BRIDGE_HOST`、
`OPENGROVE_BRIDGE_PORT`，默认监听 `127.0.0.1:37371`。Bridge 加载环境文件
时保留进程中已定义的值，按以下顺序只填充尚未定义的变量：

1. `OPENGROVE_ENV_FILE` 指定的文件。
2. `~/.opengrove/.env.local`。
3. 当前工作目录的 `.env.local`。
4. 当前工作目录的 `.env`。

这个加载流程属于 Bridge；Vite 启动器的监听/代理配置和构建变量应显式
传入启动进程，不要假设它们读取同一组 Bridge 环境文件。`web` profile
强制的 session 与 UI 开关也不会被环境文件覆盖。

额外允许的浏览器 Origin 使用 `OPENGROVE_BRIDGE_ALLOWED_ORIGINS`，逗号
分隔。保持本地监听；网络与认证边界见
[安全模型](../reference/SECURITY_MODEL.md)。Provider 配置见
[配置](../reference/CONFIGURATION.md)和[技术参考](../reference/TECHNICAL_REFERENCE.zh-CN.md)。

### 独立数据目录

两个进程不能同时写同一个 SQLite 状态文件。Desktop 开发已经与打包版
隔离；需要并行运行独立 Web 时，在它的启动终端设置：

```bash
export OPENGROVE_USER_DATA_DIR="$PWD/.opengrove/web-dev"
export OPENGROVE_DATA_DIR="$PWD/.opengrove/web-dev/data"
export OPENGROVE_STATE_PATH="$PWD/.opengrove/web-dev/data/local-state.sqlite"
export OPENGROVE_BRIDGE_SETTINGS_PATH="$PWD/.opengrove/web-dev/data/bridge-settings.json"
export OPENGROVE_WW_BASE_URL="https://accounts.example.test"
npm run dev:web
```

依次指定用户数据根、Bridge 数据目录、SQLite 文件和 Bridge 设置文件。
这套独立状态不会自动共享 Desktop 现有的 Room、App 和设置；如果端口也
冲突，同时调整后端端口与 Vite 代理地址。

不要提交 `dist/`、`web-dist/`、`desktop-dist/`、`release/`、`data/`、
`.opengrove/` 或本地验证日志。Provider Key、账号 Token 与环境配置保存在
被忽略的本地文件、环境变量或 Kernel 原生凭据存储中。

## 停止与故障排查

Web 源码启动终端按 `Ctrl+C`；分离启动时分别停止两个终端。Desktop 从
应用菜单退出，macOS 上只关闭窗口仍可能保留进程与 Bridge。

| 现象 | 检查与处理 |
| --- | --- |
| `state_locked` | 按错误中的 PID 确认持锁进程，退出它或改用独立状态目录；不要删除活跃进程的锁 |
| 锁文件无法读取 | 按错误提示区分 JSON `.lock` 标记和 `.lock.sqlite` 协调文件；不要通配删除，完整规则见技术参考的本地存储说明 |
| `37371` / `5173` 端口占用 | 确认持有端口的进程后退出它，或修改端口；自定义后端端口还需更新代理地址 |
| UI 打开但 API 不通 | 检查 `/api/bootstrap`、后端地址与代理；使用 `/ui/`，不要直接打开静态 HTML |
| `browser_ui_disabled` | 使用 `bridge:web` / `start:web`；直接启动本地 CLI 时先构建 Web 并设置 `OPENGROVE_ENABLE_BROWSER_UI=1` |
| 认证 Web 拒绝启动 | 检查 WW 地址；账号登录仍需目标环境的有效账号与服务 |
| Bootstrap 与前端不兼容 | 从同一 checkout 重建后端和 Web，再刷新页面 |
| 打包失败 | 根据首个失败阶段检查输入、Engine、版本元数据、资源或 `tar`；输出目录中有文件不代表校验已通过 |

macOS / Linux 可查看进程与端口（把 `12345` 替换为错误中的 PID）：

```bash
ps -p 12345 -o pid=,ppid=,lstart=,command=
lsof -nP -iTCP:37371 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

Windows PowerShell 可使用 `Get-Process -Id 12345` 和
`Get-NetTCPConnection -State Listen -LocalPort 37371,5173` 查看对应信息。

### 诊断事件长轮询

运行 `npm run diagnose:event-long-poll`，自动重建后端并运行带计时输出的独立
inventory 测试。测试使用临时数据，退出时清理。JSON 汇总记录事件到达、响应校验、
SQLite 调用和事件循环延迟；断言失败时返回非零退出码。

如需只延迟测试客户端收到触发用 PATCH 响应的时间：

```bash
npm run diagnose:event-long-poll -- --delay-mutation-response-ms=1600
```

事件响应仍须满足原有的 1000 毫秒上限。这个实验用于确认触发请求的响应延迟不会
混入事件投递计时，不能据此判定历史超时的原因。

## 针对性验证

按改动范围选择检查，无需为文档补充运行完整发布测试：

| 改动范围 | 检查 | 覆盖内容 |
| --- | --- | --- |
| 仅文档 | `npm run check:doc-refs` | 仓库相对链接与双语标题结构 |
| Web 开发代理 | `npm run test:web-development-proxy` | 构建后端并验证 Vite 代理 |
| 构建后 Web 启动 | `npm run test:web-single-startup` | 构建后端与 Web，检查 UI、Bootstrap、未登录 Session 和版本 |
| Web 打包 | `npm run test:pack:web` | 单元检查及实际构建、打包、归档内容检查 |
| Desktop 开发启动 | `npm run check:desktop-dev-runtime` | 开发身份、进程识别、启动与锁恢复逻辑 |
| 当前平台 Desktop 打包 | `npm run pack:desktop` | 构建、输入和产物校验；随后人工打开应用 |

验证结果应写明执行的命令、平台/架构、实际产物路径，以及已检查和未检查
的运行行为。更广改动按[AGENTS.md](../../AGENTS.md)选择验证层级。

## 实现入口

需要核对或更新本文时，从以下文件查看真实行为：

- [package.json](../../package.json)：可用命令与命令链。
- [构建调度](../../scripts/build.mjs)、[后端构建](../../scripts/build-server.mjs)和[客户端构建](../../scripts/build-clients.mjs)：构建依赖与顺序。
- [Desktop 主入口](../../desktop/main.ts)与[开发重启](../../scripts/restart-desktop-dev.mjs)：通道、数据隔离和就绪探测。
- [Web 联合启动](../../scripts/start-web-dev.mjs)与[Vite 配置](../../vite.config.ts)：监听范围、代理和构建元数据。
- [Web profile](../../src/profiles/web-single.ts)与[Bridge 配置加载](../../src/server/bridge-security.ts)：认证和环境优先级。
- [Web 打包](../../scripts/pack-web-artifact.mjs)、[Desktop 打包配置](../../electron-builder.yml)和[Desktop 产物检查](../../scripts/check-desktop-artifact.mjs)：归档布局与验证范围。
