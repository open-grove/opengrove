# 从源码构建 OpenGrove

本文覆盖源码安装、桌面端与浏览器开发、需认证的单用户 Web
profile、构建产物和本地打包。

## 环境要求

- Node.js 24
- 随受支持的 Node.js 24 版本附带的 npm
- macOS、Windows 或 Linux

`packageManager` 字段为会读取它的工具记录一个兼容的 npm 版本；
仓库和 CI 不要求必须使用该精确版本。

按 lockfile 安装精确的依赖树：

```bash
git clone https://github.com/open-grove/opengrove.git
cd opengrove
npm ci
npm run check:static
```

当前 package 关闭了 npm 公开发布。执行 `npm run build:server` 后，
源码 checkout 应使用 `node dist/cli.js ...`，不要假设系统中已经存在
全局 `opengrove` 命令。仅使用 API 的 CLI 有该构建即可；如果要提供
浏览器 UI，还必须执行 `npm run build:web`。

## 开发入口

| 目标 | 命令 | 结果 |
| --- | --- | --- |
| 桌面端开发 | `npm start` 或 `npm run desktop:dev` | 构建全部目标并启动 Electron 开发壳 |
| 重启桌面端开发 | `npm run restart:desktop-dev` | 停止当前开发进程、重新构建、启动并探测 Bridge |
| 本地浏览器 UI | `npm run bridge:web` | 构建全部目标，并在 `http://127.0.0.1:37371/ui/` 提供 Bridge-token UI |
| 认证 Web 联调 | `npm run dev:web` | 构建 server，在 `37371` 启动 session-auth Bridge，在 `5173` 启动 Vite，server 源码变化时重建 backend |
| 仅运行认证 Web backend | `npm run dev:web-backend` | 构建并启动 `node dist/cli.js web` |
| 仅运行认证 Web frontend | `npm run dev:web-frontend` | 启动 Vite，默认把 Bridge 请求代理到 `http://127.0.0.1:37371` |
| 运行已构建认证 Web | `npm run start:web` | 构建 server 和 Web 产物，再由 session-auth Bridge 统一提供 |

`bridge:web` 和 `web` 是两种不同的 profile。`bridge:web` 是可用 Bridge
token 保护的本地开发界面；`web` 要求 WW session 认证，未配置
`OPENGROVE_WW_BASE_URL` 时会拒绝启动：

```bash
OPENGROVE_WW_BASE_URL=https://accounts.example.test npm run dev:web
```

上述 URL 是占位符，请使用你有权测试的账号服务 origin。WW 负责账号
session；本地 Bridge 继续负责 workspace、SQLite state、Apps 和原生 Kernel
进程。该 profile 是单主体的，不是多租户 hosted agent runtime。

环境文件优先级和 Provider 配置见[配置](../reference/CONFIGURATION.md)与
[技术参考](../reference/TECHNICAL_REFERENCE.zh-CN.md)。

## 状态隔离

两个 OpenGrove 进程不能同时写同一个 SQLite state 文件。桌面端开发已经
使用独立的开发 app-data 目录。如果要同时运行另一个 Bridge，请为它指定
独立数据根目录：

```bash
export OPENGROVE_USER_DATA_DIR="$PWD/.opengrove/web-dev"
export OPENGROVE_DATA_DIR="$PWD/.opengrove/web-dev/data"
export OPENGROVE_STATE_PATH="$PWD/.opengrove/web-dev/data/local-state.sqlite"
export OPENGROVE_BRIDGE_SETTINGS_PATH="$PWD/.opengrove/web-dev/data/bridge-settings.json"
export OPENGROVE_WW_BASE_URL="https://accounts.example.test"
npm run dev:web
```

`.opengrove/` 已被 Git ignore。Provider 凭据和账号服务配置应留在被忽略的
本地环境或 settings 文件中，不能写进被跟踪的命令或文档。

## 构建与打包

| 产物 | 命令 | 生成位置或文件 |
| --- | --- | --- |
| Server 和源码 CLI | `npm run build:server` | `dist/` |
| 浏览器 UI | `npm run build:web` | `web-dist/` |
| Electron main 与 preload | `npm run build:desktop` | `desktop-dist/` |
| 全部源码目标 | `npm run build` | 上述所有目录 |
| 可部署 Web backend | `npm run pack:web:backend` | `release/web/opengrove-<version>.tgz` |
| 可部署 Web frontend | `npm run pack:web:frontend` | `release/web/opengrove-web-<version>.tar.gz` |
| 未打安装包的桌面应用 | `npm run pack:desktop` | 当前平台的 Electron unpacked 产物 |
| 本地桌面安装包 | `npm run dist:desktop` | `release/desktop/` 下的当前平台安装包 |

`build` 只负责编译源码；`pack:web:*` 创建并校验可独立部署的 Web
archive；`pack:desktop` 创建用于本地检查的未打包桌面产物；
`dist:desktop` 创建当前平台的安装包，不能代替签名、公证和跨平台
门禁的正式发布 workflow。

桌面端原生 runtime 组件必须在对应 OS 上 staging，Windows 安装包也应在
Windows 上构建。正式 macOS/Windows 版本由 CI 构建并通过门禁，详见
[发布流程](RELEASE_PROCESS.zh-CN.md)。

不要提交生成的 `dist/`、`web-dist/`、`desktop-dist/`、`release/`、
`data/`、`.opengrove/` 或本地证据文件。

## 针对性验证

先运行能覆盖当前改动的最小检查，再按风险扩大：

```bash
npm run test:web-development-proxy
npm run test:web-single-startup
npm run test:pack:web
npm run check:desktop-dev-runtime
npm run check:doc-refs
```

较大的产品改动请遵循 `AGENTS.md` 中的验证要求。

## 故障排查

- **`37371` 或 `5173` 端口被占用：**停止其他 Bridge/Vite 进程，或者用
  `OPENGROVE_BRIDGE_PORT` / `OPENGROVE_WEB_DEV_FRONTEND_PORT` 选择未使用端口。
- **`state_locked`：**另一个 Bridge 正占用同一 SQLite 文件。停止它，或设置
  不同的 `OPENGROVE_STATE_PATH`；不要删除活跃进程的 lock。
- **`browser_ui_disabled`：**使用 `npm run bridge:web` 或 `npm run dev:web`。
  如果直接启动源码 CLI，先执行 `npm run build:web`，再设置
  `OPENGROVE_ENABLE_BROWSER_UI=1`。
- **Host Bootstrap 与 frontend 不兼容：**从同一 checkout 重建 server 和 Web 产物，
  然后刷新页面。
- **认证 Web 拒绝启动：**把 `OPENGROVE_WW_BASE_URL` 设置为有权使用的
  账号服务 origin，并确保 frontend 与 backend 使用同一环境。
