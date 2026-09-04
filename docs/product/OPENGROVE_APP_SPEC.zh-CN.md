# OpenGrove App 目录规范

OpenGrove App 是从 Settings -> Apps 挂载的本地目录。它是业务或产品专属能力的顶层单位：UI、skills、tools、MCP 配置、hooks、scripts 和 assets 可以共存于同一个根目录下。

OpenGrove 在用户设置里只保存 app root path、enabled state，以及可选的 display name。

在本文档里，App 指把 UI、skills、CLIs、tools、MCP 配置、hooks、scripts、assets 和 workspace 文件组织进一个挂载 workspace 的顶层产品/业务包。

## App 平台入口

OpenGrove 的“新建应用”不是单纯保存一个路径，而是创建或接入一个可传递的工作台包。Settings -> Apps 提供两条入口：

- **导入已有 App**：用户提供本地目录或 URL。OpenGrove 把来源、可选名称和接入边界交给默认 kernel/agent。Agent 先判断来源是否已有完整 UI；已有 UI 时保留界面，但要打包成标准 MCP App 资源。没有 UI 时，在宿主文件工作台和新 MCP App UI 之间选择。
- **描述创建 App**：用户用自然语言描述工作台。Host 先创建并立即打开 `setup` 骨架，确定性询问使用内置工作台还是自定义 View；选择后再由 App 构建师生成真实 UI/工作区、必要 skill/CLI 文档和 smoke 数据。

导入或创建任务应触发 `opengrove-app-builder` skill。这个 skill 是 agent 的接入护栏：它要求 agent 明确 App 根目录、workspace 边界、UI 复用策略、命令契约、模型/API 依赖和验证结果。

导入来源要先分类再改动：

- 本地文件夹可以原地 inspect。
- Git/GitHub URL 要先 clone 到 OpenGrove 托管的 staging 目录。
- 压缩包 URL 要先下载并解压到 staging 目录。
- 普通项目路径或 URL 要先判断它是 Web 项目、CLI 工具包、脚本集合、资料目录还是混合项目，再决定是桥接、补 scaffold，还是生成 UI。

OpenGrove 给 agent 提供确定性的辅助命令：

```bash
opengrove app inspect <source>
opengrove app import <source> --target <app-dir> --id <id>
opengrove app stage <source> --apps-dir <managed-apps-dir> --id <id>
opengrove app scaffold <target> --id <id> --title <title>
opengrove app validate <app-root>
opengrove app report <app-root>
opengrove app mount <app-root> --settings <settings-path>
```

这些命令不替代 agent 判断；它们负责把 App 边界、manifest 契约和验证结果变成可复现的步骤。

上述示例使用已安装的命令名。在源码 checkout 中，先运行
`npm run build:server`，再把 `opengrove` 替换为 `node dist/cli.js`。

`stage` 是导入落盘步骤：Git 来源会 clone，压缩包会下载并解压，本地目录可以原地引用，也可以用 `--copy` 复制到托管目录。`report` 会合并来源分类、manifest 校验和建议挂载项。`mount` 只在 App 已经可挂载后，更新明确指定的 bridge settings 文件。

## App 商店分发

App 商店 registry 分发的是可移植 App 包，不是这些 App 的远程运行时。OpenGrove 会
直接把安装包下载并解压到平台原生的 Programs 目录。挂载后的 App、员工、`AGENTS.md`、skills、
tools、hooks，以及后续 agent 编辑都在用户本机。安装实例运行后生成或保留的
workspace 文件同样只存在于该用户本机。

商店托管的程序文件与 App Workspace 具有独立生命周期。每次安装或正式版本切换
都会创建新的程序世代，把 manifest 声明的 workspace 位置绑定到由 Host 持有的
持久化 Workspace，验证通过后才切换挂载的程序指针。指针提交后再清理旧程序；
Windows 上的短暂文件占用最多只会推迟这项清理，不会移动、替换或删除 Workspace。
从旧布局首次升级时，Host 会在同级临时目录中分别复制并完整校验 Workspace 与程序，
再通过 rename 落到平台原生的新目录，最后原子切换两个挂载路径。任一步失败都继续以旧路径
为准；迁移后的 App 成功启动后，旧目录只改名保留，不在迁移中删除。全新安装直接使用这一
分离布局。

WW 可以通过全局与 Role 映射推荐默认 App。鉴权后，Host 解析当前用户策略，
对缺失项复用正式 App Store 的下载、校验、安装、激活与回滚链路。Host 的
`clientReleaseNumber` 变化后，还会检查当前仍被分配、来源可信且最初由默认策略
自动安装的 Store App，只在 Store 版本更高时更新。已有的手动 Store 安装可以满足
策略，但继续由用户管理；同一 Host 版本不会重复下载更新，但策略显式提高
`minimumVersion` 时可以提前更新。用户显式卸载、禁用、手动挂载、需要 relink
或来源冲突的决定仍然优先；取消分配不会自动卸载 App 或删除 workspace。

`opengrove app pack` 和 `publish` 会排除 manifest 声明的整个 workspace 根目录及
其内容；workspace 是每个安装实例的可变用户状态，不是发布资产。全新安装时该
目录可能完全不存在，更新安装则会保留现有 workspace。App 不得假设开发机中的
workspace 种子文件会随包分发：首次启动或首次命令必须自行创建所需目录，并在可
初始化的场景把 `ENOENT` 视为“尚无本地状态”。发布验证必须从实际 `.tgz` 解压到
空目录后执行首次启动或首个真实命令；带历史 workspace 的开发/更新安装不能替代
该验证。

如果 App 依赖某个 Host 客户端版本才提供的行为，必须在 manifest 中用正整数
`store.minHostReleaseNumber` 声明最低发布号。Host 会把自身
`clientReleaseNumber` 发给 registry。对支持兼容提示的 Host，registry 会返回不含
安装归档信息的提示记录；对旧 Host 则完全省略该记录，并拒绝所有不兼容详情或下载
请求。这样新版 Host 可以提示先升级 Host，旧版 Host 也不会把它识别成可安装的 App
更新。Host 在下载和改动本地文件前还会再检查一次。未声明该字段的包保持兼容旧 Host。

同一个逻辑包版本的发布必须可安全重试。OpenGrove 会按 registry、本机 App 身份、
可选包身份、版本、发布类型、可见性和草稿摘要生成稳定幂等键。向远端发送请求前，
Host 先持久化本机草稿和发布意图日志。日志在重试中始终跟随同一个 Release Commit、GitHub CI run、
不可变制品摘要和 registry 版本；重新打开 App Store 会继续未完成意图，而不是创建
另一个版本。同一版本仍有未完成日志时若源码内容已变化，OpenGrove 会停止发布，
要求恢复原意图或升级版本号。

未完成发布只锁定当前 App，不影响目录中的其他 App。任何当前 WW Admin 都可以查看同一笔
远端发布；只有本机保存的完整发布请求（源码、版本、App 信息和发布基础）都与远端意图一致时，
才可以继续它。系统不会用另一份本机发布请求静默替换旧任务；管理员必须等待旧任务完成，
或在它过期后显式结束。`awaiting_candidate` 或
`building` 仍在推进时不可结束；只有连续
两小时没有持久化状态更新后，管理员才可以显式结束并重新开始。结束操作会用最后看到
的状态更新时间做 compare-and-swap，若任务恰好又向前推进则拒绝结束；已失败的受信构建
可以立即显式结束。

发布内容必须适合分享给其他用户，也必须完整到让有权使用 App 的成员可以继续在
本机编辑。包中必须包含可运行资产、完整可编辑 UI/源码输入、构建配置与锁定文件、
模板、manifest 元数据、员工、skills、hooks 和 scripts。Host 按结构路径规则自动排除
Git 历史、已知原生 session/config 目录、缓存和 workspace 内容；打包器不解释任意
源码文件内容，发布者仍负责不把 provider keys、数据库 URL、本机绝对路径、私有数据
dump 或机器专属 token 放入包内。App 专属安装或使用说明应写进 `AGENTS.md` 或随包
skill，让 Grove 或 App 员工在安装后引导用户。

已挂载 App 使用统一的“保存与发布”页面。所有有权使用该 App 的成员都能在这里保存
这次 OpenGrove 本机安装唯一的草稿；正式发布仍是管理员操作，只有管理员看到并能
调用，远端服务也必须做相同鉴权。正式发布前，Host 从已挂载 App manifest 和每个
已启用 App 员工的当前有效配置准备发布快照；管理员可以在同一页面调整 App 元数据、
向上递增的 SemVer、版本说明、可见性和员工安装默认值。页面编辑时不改写正在运行的
实例。草稿没有 SemVer、不上传，归本机安装而不是 WW 账号；点击发布会先保存页面当前内容。
发布失败或中断保留草稿。卸载 App 时询问保留或删除草稿，默认保留；撤销远端 App
可见性不会删除已经存在的本机草稿。版本管理页可以把已保存草稿重新打开为当前运行
内容，但不会改写设备选中的正式版本或草稿发布基础；切回正式版本也不会删除草稿。

正式发布时，Host 先保存可恢复的 prebuild 草稿；存在本机发布构建配方时，Host 在
该精确草稿的隔离副本中执行 argv 命令，只事务式提升声明输出，再保存 postbuild
精确草稿。构建失败、取消、超时或工作副本并发变化均不得创建远端任务。Host
会在成功、失败、超时和取消时终止并等待自己启动的进程组；构建命令不得 daemonize
或主动脱离该进程组，Host 也不会通过扫描整台机器来终止无关进程。这些隔离与环境
过滤不是 OS 沙箱；构建命令仍以当前 OS 用户权限执行，管理员只能发布可信来源的
App。在 Windows Host 通过原生 Job Object 承载构建前，Windows 会在执行任何构建
命令或创建远端发布前明确失败。
随后 Host
把 postbuild 草稿规范化为内容寻址源码快照，并通过 Release
Control 的受控上传会话传输。该源码运输绑定草稿摘要和预期 `main` SHA，
只用于让 Release Control 的 GitHub App 创建候选 Git tree；它不是正式 tgz，
不进入 registry，也不能安装。源码快照最多包含 5,000 个文件；Workspace 和其他
仅限本机的路径既不计入该上限，也不会进入快照。Release Control 校验源码清单并创建 Git 对象，
但不在自身服务进程中运行 App 构建脚本。WW 只提供账号、状态和角色事实，
不接收源码、不编排发布，也不保存新的 App 正式版本。

兼容窗口内，现有 GitHub workflow 仍可在不持有发布凭据的前提下重放同一配方，但其
输出会被丢弃且绝不用于分发；只有具备本机构建能力的 Host 已成为最低发布版本、旧 run
排空后才能删除这次重放。目标 workflow 再由固定 SHA 的 Builder 从同一候选提交生成
正式 tgz，GitHub Actions Gate 对该真实 tgz 执行一次完整语义验证。第一份通过全部门禁
的制品成为该发布唯一被接受的正式制品并
固定摘要。tag、GitHub Release、registry 和客户端只
复用这份相同字节，后续组件不得重建或替换。Release Control 负责发布前通过
WW 实时确认 Admin 身份、编排发布、登记 registry 并提供 OSS 不可变制品的精确下载；
它不接收客户端 tgz 后重打包。默认情况下，Host 会在发布设备上激活刚发布的确切
正式制品，完整采用其员工默认值、选中该正式版本并关闭草稿。管理员可以关闭
“同时应用到我当前的 App”；关闭后选中正式版本不变，草稿保留且发布基础推进到新版本。
两条路径都保留本机 workspace 和 Room 历史。

正式顺序固定为：候选提交 → 可重跑 CI 门禁 → 固定 accepted artifact 摘要 →
以 `expectedMainSha` 对 `main` 做最终 compare-and-swap → 创建不可变 tag →
把已经接受的同一字节附着到 GitHub Release → 登记 registry。首次发布以 `main`
不存在为前提。一笔发布意图所有阶段收敛前，OpenGrove 不显示成功，Release
Control 也拒绝该 App 开始下一笔正式发布。

受信发布 workflow 是平台供应链边界，不属于 App 内容。App 源码和草稿不能替换该
workflow，也不能读取 release secrets。App 自己声明的构建/测试命令在 Host 的隔离
草稿副本中运行且不获得发布凭据；迁移期旧 GitHub 重放同样不持有发布凭据并丢弃结果，
兼容门禁完成后 GitHub 才只运行平台固定的 Builder 与 Gate。

发布快照是全新安装的权威默认值。管理员身份区可以显示本机 App 与 workspace 根路径
供核对，但这些机器路径不进入发布请求或包。安装者不确认或重新解释员工默认值。
`store.employeeDefaults` 可以携带员工身份、角色、Kernel/模型、思考等级、上下文
token 预算、访问模式、Skills、可见性和公开契约字段。Host 仍为员工注入安装实例
专属 App 上下文，并把后续本地编辑保留为当前版本的用户覆盖。员工的有效思考等级按“用户显式选择 →
Kernel 支持的 App 默认值 → Kernel 默认值”解析；App 默认值不被当前 Kernel 支持时，回退到 Kernel
默认值，且不记为用户覆盖。版本不递增、manifest/UI 无效、App Skill 缺失，或包结构、
Workspace 排除、包身份、runtime receipt 元数据校验失败时阻断发布；打包器不检查任意
文件内容。版本说明为空或尚未完成完整试运行只警告。

从未进入 registry 的 App 首次发布建议 `0.1.0`，由管理员在同一事务中创建唯一仓库
映射和初始 `main`。App id、package key、registry 身份或既有仓库映射冲突时阻断。

每个已安装 App 都有一个本机选中的正式版本。本机发布新版本时默认选中这个确切版本，
除非管理员显式关闭本机激活；其他设备发布的版本不会静默改变它。版本管理页读取 registry 的
正式版本目录，并通过同一事务化安装接缝激活指定兼容版本。兼容性继续使用
`store.minHostReleaseNumber`；切换会替换程序和员工默认值，但不会回滚 workspace、
聊天、凭据、业务数据或已保存本机草稿。

## UI 策略

`ui.surface` 只决定 App 自身显示哪种画布，与自定义 View 使用的协议分开。App 不再获得第二层标题栏；当前 App 的开发模式从 OpenGrove 全局标题栏进入：

1. **施工态**：新 scaffold 的 App 使用 `ui.surface: "setup"`。Host 直接展示内置工作台 / 自定义 View 选择，并默认打开 App Room 施工队；`setup` 不能 pack 或 publish。
2. **宿主工作台**：文件/产物型工作流使用 `ui.surface: "file-workbench"`。App 可以选择 OpenGrove 封闭组件池中的 tab，也可以用标准 MCP App 合同把某个 `view` tab 的主画布交给 App-owned UI；自定义代码仍不能进入 Host 同源执行环境。
3. **可移植自定义 View**：独占整个 App 画布的自定义前端使用 `ui.surface: "view"` 和 `ui.view.protocol: "mcp-app"`；保留文件工作台外壳时使用 `ui.tabs[].component: "view"`。两者的构建产物都以标准 `ui://` 资源和 `text/html;profile=mcp-app` MIME 暴露；View 只通过 MCP Apps 协议和 manifest 明确授权的 per-App tools 与宿主交互。
4. **无画布**：以 Employee、Skill、CLI、MCP 或 Routine 为主的 App 使用 `ui.surface: "none"`。
导入已有完整前端时，保留其 UI 源码，但把宿主接入改为标准 MCP Apps 调用；React、Vue、Svelte、Canvas、TypeScript、服务端代码等都可以继续是 App 组成部分，最终 HTML resource 只是浏览器构建产物。不得保留直连 Bridge HTTP API 的代码，也不得新建同源自定义挂载。

旧 `ui.kind` 只做运行时兼容，不自动回写：`file-workbench` 归一化为同名 surface，`mcp-app` 归一化为 `view`。保留值 `ui.kind: "native"` 和 `ui.kind: "custom"` 仍不可运行，绝不是新 `view` 的别名。

通用行为必须优先抽成共享组件，再由业务 adapter 接回去。目录树、Markdown/媒体预览、设置表单、状态列表、对话面板等不应为单个 App 复制一份。若现有组件绑了业务逻辑，应先拆出无业务的组件层。

## MCP App 契约

最小自定义 UI 声明：

```json
{
  "ui": {
    "surface": "view",
    "workspace": "workspace",
    "view": {
      "protocol": "mcp-app",
      "entry": "ui/index.html",
      "tools": [
        "opengrove.app.workspace.list",
        "opengrove.app.workspace.read"
      ],
      "csp": {
        "connectDomains": [],
        "resourceDomains": [],
        "frameDomains": [],
        "baseUriDomains": []
      }
    }
  },
  "workspace": { "path": "workspace" }
}
```

可选 per-App tools 为 `opengrove.app.workspace.list`、`opengrove.app.workspace.read`、`opengrove.app.workspace.write`、`opengrove.app.flows.list`、`opengrove.app.command.run` 和 `opengrove.app.media.cache`。Manifest 是白名单：没声明的 tool 会被拒绝。`command.run` 只接受 `capabilities.cli` 中已声明的 `commandId`，View 不能传入任意可执行命令。

`command.run` 将 `parseJson` 视为结构化结果契约。默认的 `parseJson: true`
下，非空的非法 JSON 以 `command_output_not_json` 失败；退出码为 0 且无输出的命令
仍然成功，结果中同时省略 `json` 和 `stdout`。超过 Host 捕获预算的输出以
`structured_output_too_large` 失败；Host 不会把残缺 JSON 当作成功结果返回。
结构化结果成功时只在 `json` 中提供，不再在 `stdout` 中重复。确实需要返回文本
的 App 必须显式设置 `parseJson: false`；文本结果会携带字节数和明确的截断标记。
`stdoutBytes` 和 `stderrBytes` 统计进程实际发出的全部原始字节；
`capturedStdoutBytes` 和 `capturedStderrBytes` 统计 Host 预算内保留、
但尚未做文本去空白和 UTF-8 边界修复的原始字节。

`media.cache` 只允许下载 Manifest CSP 已声明的 HTTPS 音视频地址；完整文件进入 App 的本机隐藏缓存后，Host 返回短期本地 Range 播放地址，以及供该 App 声明式 CLI 使用的 workspace 相对路径 `workspacePath`。Host 不向 View 暴露本机绝对路径；声明式 CLI 必须把 `workspacePath` 与 Host 注入的 `OPENGROVE_APP_WORKSPACE_ROOT` 组合，而不能按命令当前工作目录解析。`workspacePath` 是可淘汰的缓存定位，不是永久引用。

媒体缓存上限同时统计完整文件、半文件和在途容量预留；仍有 HTTP 播放租约的文件不参与 LRU 淘汰。

View 在跨源、不含 `allow-same-origin` 的 opaque-origin iframe 中运行。沙箱域名只提供 MCP App 代理资源，任何 Bridge API 路径在该域名下都返回 `404`。默认 CSP 禁止网络请求；只加入 App 声明且通过校验的 HTTPS 域名，并始终剔除 Host 和 sandbox 自身来源。Hosted 部署必须把 `OPENGROVE_MCP_APP_SANDBOX_ORIGIN` 配置成一个独立域名，并路由到 Host 的 sandbox handler。

Host 声明支持 `fullscreen` 时，View 可以通过 MCP Apps display-mode 协议请求进入。全屏始终保留宿主拥有的退出按钮；焦点位于 Host 或沙箱 View 内时，Escape 都会退出。iframe 重载后，新 bridge 会继承宿主当前 display mode，不会把仍处于全屏的宿主误报为 `inline`。

### 宿主 UI 能力

宿主的 UI 能力来自单一注册表，且所有平台声明同一套能力面：能在 Web 宿主里用的能力，桌面宿主一样能用。App 不声明自己需要哪些宿主能力，manifest 里也没有这个字段。

| 能力 | App 能做什么 | 落点 |
| --- | --- | --- |
| `openLinks` | `app.openLink({ url })` | 每次请求都由用户确认目标站点，再交给浏览器打开 |
| `downloadFile` | `app.downloadFile({ contents })` | 用户确认一批文件后，宿主走浏览器下载通道写盘 |
| `serverTools` | `app.callServerTool(...)` | `ui.view.tools` 中已声明的 per-App tools |
| `serverResources` | `app.listServerResources(...)`、`app.readServerResource(...)` | App 自己的 MCP 资源 |
| `logging` | `app.sendLog(...)` | 宿主诊断，不进对话 |
| `sandbox` | 读取宿主实际应用的 CSP 与 iframe 权限 | 来自 `ui.view.csp` |

`message`、`updateModelContext` 和 `sampling` 属于规范能力集，但宿主目前还没有声明，因此相关请求会被拒绝。不要假设能力存在：`connect()` 之后读 `app.getHostCapabilities()`，并在界面上给出降级路径。

```ts
const capabilities = app.getHostCapabilities();

if (capabilities?.downloadFile) {
  await app.downloadFile({
    contents: [{
      type: "resource",
      resource: { uri: "file:///chapter-3.txt", mimeType: "text/plain", text },
    }],
  });
} else {
  showHint("请手动复制章节内容。");
}
```

拒绝方式由规范决定，不靠约定：`ui/open-link` 和 `ui/download-file` 在用户取消或宿主拒绝时返回 `isError: true`。

宿主侧的上限在进入用户视线之前就生效：链接最长 4096 字符，下载一次最多 5 个文件、每个 8 MiB。View 处于后台时，这两类请求都会被拒绝，直到用户把它切回前台。

## 文件工作台 tabs

使用 `ui.surface: "file-workbench"` 的 App 可以声明工作台 tab。内置组件池由
OpenGrove 维护且是封闭的；需要业务自定义 UI 时，App 可以声明 `view` tab，把主画布
交给标准 MCP App View。自定义代码始终在跨源 sandbox 内执行，不进入 Host 页面。

```json
{
  "ui": {
    "surface": "file-workbench",
    "workspace": "workspace",
    "workbenchLayout": { "filesWidth": 180, "chatWidth": 800 },
    "tabs": [
      { "component": "file-tree", "label": "文件" },
      { "component": "flow-list", "label": "工作流" },
      {
        "component": "dashboard",
        "label": "我的看板",
        "source": { "type": "local_mock" }
      },
      {
        "id": "work-management",
        "component": "view",
        "label": "作品管理",
        "view": {
          "protocol": "mcp-app",
          "entry": "ui/work-management.html",
          "tools": ["opengrove.app.workspace.list"]
        }
      }
    ]
  }
}
```

`ui.workbenchLayout` 可选，用像素声明该 App 首次打开时的文件区和聊天区宽度。
Host 会把值限制在可用范围内；用户在分隔条上的手动调整按 App 保存在本机，并优先于
manifest 默认值。仅调整窗口大小只会临时约束实际显示宽度，不会覆盖用户保存的偏好，
窗口重新变宽后会恢复该偏好。未声明时使用 Host 默认值：文件区 `280px`、聊天区
`420px`。

如果没有声明 `ui.tabs`，OpenGrove 回退到 `file-tree` 和 `flow-list`。未知
component 会被忽略并输出 warning。当前支持：

- `file-tree`：App workspace 文件树，接入新建、导入、重命名、移动、删除和预览。
- `flow-list`：基于 workspace 内 `*.flow.md` 的工作流状态列表。
- `dashboard`：结构化报告列表和详情面板。dashboard bridge route 返回脱敏档位和
  定性建议。本地临时实现里，整个看板可以走本地 mock 数据，佣金只是展示用
  mock 字段，必须标记
  `source: "local_mock"` 和 `mock: true`；App 不得把它当作结算数据。
- `view`：App-owned MCP View。必须提供 URL-safe、App 内唯一的 `id` 和完整 `view`
  合同。激活时占据 Workbench 主画布，Host 顶部 tab 与当前 App Room 聊天保持可用；
  合同失败只在该画布报错。每个 View Tab 只获得自己 `view.tools` 中声明的工具。

## Workspace 写入体验

如果 App 会产生用户可见文件，默认应写入：

```text
workspace/runs/<task-or-command>-<timestamp>/
```

文件工作台必须支持用户能理解的基本操作：浏览、预览、新建文件/文件夹、重命名、移动、删除、刷新。所有写操作都必须限制在 manifest 声明的 workspace 或 App 根目录内。

## 必需根文件

每个 app 应提供一个 manifest：

```text
opengrove.app.json
```

最小 manifest：

```json
{
  "id": "sample-workbench",
  "title": "Sample Workbench",
  "description": "Portable workflow package for OpenGrove.",
  "version": "0.1.0"
}
```

`id` 必须稳定、小写且 URL-safe。App 和 Employee id 是不区分大小写的身份，因此 manifest 会直接拒绝大写写法，而不是静默地把两个声明压成同一个身份。`title`、`description` 和 `version` 只用于展示和 inventory。

## 本地化显示元数据

App 可以把默认显示文案保留在 manifest 根部，并在 `locales` 中声明仅用于显示的翻译。`defaultLocale` 标识根部文案所用的语言。Locale key 必须是有效的 BCP 47 语言标签；本地化后的 tab、Employee 和 CLI 均使用其稳定的 manifest id 作为 key：

```json
{
  "defaultLocale": "zh-CN",
  "welcome": { "message": "欢迎使用示例 App。" },
  "ui": {
    "tabs": [
      { "id": "workspace", "component": "file-tree", "label": "工作区" }
    ]
  },
  "employees": [
    {
      "id": "writer",
      "name": "作者",
      "role": "Canonical runtime role.",
      "publicDescription": "负责内容创作。"
    }
  ],
  "capabilities": {
    "cli": [
      { "id": "sample", "command": "sample", "title": "示例命令" }
    ]
  },
  "locales": {
    "en": {
      "title": "Sample App",
      "description": "A localized sample.",
      "ui": {
        "tabs": { "workspace": { "label": "Workspace" } }
      },
      "employees": {
        "writer": {
          "name": "Writer",
          "publicDescription": "Creates content."
        }
      },
      "capabilities": {
        "cli": {
          "sample": {
            "title": "Sample CLI",
            "description": "Runs the sample workflow."
          }
        }
      },
      "welcome": { "message": "Welcome to the Sample App." }
    }
  }
}
```

只有 App 的 `title`/`description`、tab 的 `label`、Employee 的 `name` 和 `publicDescription`、CLI 的 `title`/`description` 以及 `welcome.message` 可以本地化。`id`、技术 `name`、`role`、`instructions`、`inputSpec`、`outputSpec`、Skills、命令、Workspace 路径和 `ui.agentContext` 等运行时身份与行为字段始终保持规范值。Host 绝不会把本地化显示元数据注入 Agent prompt。目录分类如果存在，应使用稳定的枚举代码，并由 Host 翻译，而不是由 App manifest 翻译。

## 能力目录

OpenGrove 会扫描 app root 下的这些路径：

```text
opengrove.app.json
AGENTS.md
skills/<skill-name>/SKILL.md
skills/<group>/<skill-name>/SKILL.md
bin/<local-cli>
tools/
mcp.json
hooks.json
ui/
assets/
workspace/
```

当前 runtime 行为：

- `skills/` 会在 app 启用时加载到 skill catalog。App 可以把 skill 直接放在 `skills/<skill-name>/SKILL.md`，也可以让 OpenGrove 递归发现分组后的 skill roots，或者用 `skills.roots` 显式声明。
- `AGENTS.md` 或 `agents.md` 会在 app 启用时作为该 App 绑定员工的指令上下文加载。
- `capabilities.cli` 中声明的 CLI 会进入扩展 inventory；它们仍然是 agent 可通过 Bash 运行的业务原子能力，不会默认变成 tool。
- `mcp.json` 和 `hooks.json` 会作为 app-owned external configuration roots 暴露给支持这些概念的 kernels。
- `ui/` 存放 MCP App 入口资源。自定义 View 应构建成单个内联 HTML，让其他 MCP Apps Host 不依赖 OpenGrove 专用静态路由也能渲染。
- Manifest `ui.view.tools` 选择该 View 可使用的宿主 per-App bridge tools；磁盘上存在 `tools/` 目录不会自动获得信任。
- `workspace/` 是 App 的默认产物目录；OpenGrove 文件树、raw file API 和预览会通过 WorkspaceStore 读取它。

## CLI 声明

App 可以在 manifest 里显式声明业务 CLI：

```json
{
  "capabilities": {
    "cli": [
      {
        "id": "sample-workflow",
        "title": "Sample Workflow",
        "command": "./bin/sample-workflow",
        "targets": {
          "darwin-arm64": "./bin/macos/sample-workflow",
          "darwin-x64": "./bin/macos/sample-workflow",
          "win32-x64": "./bin/windows-x64/sample-workflow.exe",
          "linux-x64": "./bin/linux-x64/sample-workflow",
          "linux-arm64": "./bin/linux-arm64/sample-workflow"
        },
        "doctor": ["doctor"],
        "smoke": ["smoke"],
        "env": ["SAMPLE_WORKFLOW_ROOT"],
        "artifacts": ["workspace/runs/**"],
        "allowNativeBash": true
      }
    ]
  }
}
```

OpenGrove 会解析相对路径、检查命令是否可执行，并把结果展示在扩展管理器的 CLI 区域。`doctor`、`smoke`、`env` 和 `artifacts` 目前作为声明信息进入 inventory；后续 Runner 会基于这些字段执行自检和托管运行。

App 自带原生 CLI 时，可以用 `targets` 按
`process.platform-process.arch` 声明 `darwin-arm64`、`darwin-x64`、
`win32-arm64`、`win32-x64`、`linux-arm64` 或 `linux-x64` 目标。
Host 只采用自身实际进程的平台与架构，不读取浏览器平台信号。目标路径必须
留在 App 内；App 校验和每次受管执行都会在 spawn 前检查文件存在、原生格式、
CPU 架构及 Unix 执行权限。声明 `targets` 后，当前平台缺少目标会直接报错，
不会回退到其他平台。

`command` / `bin` 可以是 App 自带的相对路径，也可以是用户独立安装的裸命令名。对后者，OpenGrove 从当前 `PATH` 和常见的用户级命令目录中发现它；不会把该 CLI 内置进 App，也不会代替用户安装或登录。

固定参数应写在 `args` 中。Host 会先放入这些固定参数，再追加每次
`command.run` 调用传入的参数，并始终保留独立 argv 边界，不会把它们拼成
shell 命令。例如，App 自带的 Node 脚本应声明为：

```json
{
  "id": "sync-report",
  "command": "node",
  "args": ["scripts/sync-report.mjs", "--fixed"]
}
```

Host 会以 App 根目录解析相对脚本，并在发布校验和每次受管执行时都检查该
脚本，包括位于前导 Node flags 之后的脚本。Node 源码模式（`-e` /
`--eval` 与 `-p` / `--print`）不会被当作脚本路径；根目录边界检查会先
解析符号链接。已有 manifest 若把固定参数写进 `command`，例如
`"node scripts/sync-report.mjs --fixed"`，仍保持兼容；新 manifest 应使用
`command` + `args`。

所有 mounted App 员工的运行环境都会获得这组用户级命令发现路径，不以 App 是否声明 `capabilities.cli` 为前提。CLI 声明是 inventory / readiness 元数据，也是 Host 受管 `opengrove.app.command.run` 的白名单；它不是 OS 原生 shell 的权限边界。App 员工能执行当前本地 OS 用户可见的命令，全局 CLI 也可能使用自己已有的用户登录态。因此，启用并运行 App 员工等同于信任该 App 的员工指令和 Skill 作为本地 agent 代码，不应挂载或运行不可信 App。MCP App View 仍由 sandbox、CSP 和 manifest 声明的 per-App tool allowlist 单独隔离，仍不能向 `command.run` 传入任意可执行文件。未来若要运行不可信 App 或 hosted 多主体 App，必须先增加 OS 级 sandbox 或独立执行身份。Host 受管调用使用声明的 `commandId`；旧 Routine 的 `command` 字段只在精确匹配同一声明时兼容，绝不会把未解析的原始命令直接执行。

通用 Skills 安装器放入 `~/.agents/skills` 的 Skill 会进入 OpenGrove 目录，但仍需通过现有员工 Skill 分配显式授予具体员工。

## Skill Roots

如果 App 里有分组后的 skill 集合，可以显式声明集合根目录：

```json
{
  "skills": {
    "roots": [
      "skills/workflow-tools",
      "skills/document-tools"
    ]
  }
}
```

每个 root 下面应该包含一个或多个 `<skill-name>/SKILL.md` 目录。

## 默认员工

App 可以在 manifest 里声明默认群聊员工。OpenGrove 会读取这些通用声明，并把员工绑定到 App id 和 App workspace。如果没有声明员工，Host 不再自动创建含义不明的 App Operator；除非设置 `disablePmAgent: true`，Host 默认会创建一个可选 PM。这个 PM 初始是群管理员，可在当前 App 范围内直接完成能力足够、风险可控的任务，或提示用户新增员工；用户也可以像管理其他群成员一样移除 PM 或取消其管理员身份，启动同步不会把它偷偷加回来。用户还可以从 App 群组的成员面板添加全局员工；添加 App 构建师时，Host 会创建当前 App 专属的 scoped binding，不会把全局 `app-builder` member id 直接加入 App 群组。

```json
{
  "employees": [
    {
      "id": "asset-editor",
      "name": "Asset Editor",
      "kernel": "claude-code",
      "model": "claude-code-default",
      "role": "Prepare workspace assets and previews.",
      "defaultSkillIds": ["asset-query", "project-render"]
    }
  ]
}
```

同一个数组也可以放在 `capabilities.employees` 或 `rooms.employees`。Employee id 必须小写、URL-safe，并且在一个 App 的所有 Employee 声明数组中唯一。OpenGrove 会把 Employee id 作用域限定在精确的 App id 下，并用无歧义的分量编码生成 Room member id。默认 skills 会从 employee 的 `defaultSkillIds`/`skills`、manifest 的 skill 声明，以及 `skills/*/SKILL.md` 名称里合并。

App 员工省略 `kernel` 时，Host 会落盘产品 Kernel `claude-code`；该员工同时省略
`model` 时，会获得具体产品模型 `deepseek-v4-flash`。员工显式选择其他受支持
Kernel 但省略模型时，会保留该 Kernel 的 `${kernel}-default` 运行时标记。App
种子生成不会读取本机 Kernel 配置，因此同一份 App 声明在不同设备上保持可移植。
Host 系统员工拥有各自的默认值：Grove Guide 使用 `deepseek-v4-flash`，App 构建师使用
`claude-opus-4-8`，PM 使用 `deepseek-v4-flash`，Kernel 均为 `claude-code`。这些默认不给员工写死
Provider，最终路由仍由所选模型的用户默认绑定决定。旧模型值 `native` 只作为升级输入读取，
新员工状态不再写入。

## 运行环境注入

App 可以声明：请 OpenGrove 把某些 provider key 注入到这个 App 的 agent/runtime
环境里。这个能力用于私有业务 CLI：CLI 继续读取常见 env 变量，但用户只需要在
OpenGrove Providers 里配置一次凭证。

```json
{
  "runtimeEnv": {
    "providerKeys": [
      {
        "providerId": "aws-bedrock-api-key",
        "env": {
          "apiKey": "AWS_BEARER_TOKEN_BEDROCK"
        },
        "required": false
      },
      {
        "providerId": "gemini",
        "env": {
          "apiKey": ["GOOGLE_API_KEY", "GEMINI_API_KEY"]
        },
        "required": false
      }
    ]
  }
}
```

OpenGrove 会从 settings 里找到对应 provider，读取已保存的 key 或 provider
声明的 key 环境变量，并且只在这个 mounted App 发起的 turn 里注入这些 env
名字。密钥明文不会进入 prompt、事件流、文件预览、扩展 inventory 或 App
settings。

对于 Codex，OpenGrove 会按注入后的 runtime environment 启动隔离的
app-server 进程，所以 App 专属 env 不会串到普通对话或其他 App。

## Flow 文件

App 可以在 workspace 内用 `*.flow.md` 描述需要人类审计的长流程。Flow 文件由
YAML frontmatter 记录机器可读状态，正文仍是普通 Markdown，旧版 OpenGrove 会按
普通 Markdown 降级渲染。

```yaml
---
flow: v1
title: SHZC-A01 异常处置
status: waiting_user
initiator: attribution-analyst
started: 2026-06-10T07:04+08:00
updated: 2026-06-10T07:08+08:00
steps:
  - id: s1
    title: 异常确认与数据摘要
    owner: attribution-analyst
    status: done
    output: attribution/reports/2026-06-09.md
  - id: s2
    title: 选定处置方案
    owner: user
    status: waiting
    blocking: true
    note: 推荐方案②降价缩量
---
```

`flow: v1`、`title`、`status` 和至少一个 `steps` 条目是必填项。Flow
状态取值为 `pending`、`running`、`waiting_user`、`done`、`failed`；
步骤状态取值为 `pending`、`running`、`waiting`、`done`、`failed`。

OpenGrove 把 Flow 当作只读预览面。Bridge 提供 `GET /apps/:appId/flows`
列出 flow 文件和校验问题；文件工作台会把 `.flow.md` 预览成标题、状态、进度、
步骤和 Markdown 正文。状态变更仍通过普通 workspace 写入完成，或由 App 员工在
对话确认后回写文件。
mounted App 的默认协作现场是 App 绑定群组。Flow 文件只是这个群组的状态记录；
v1 不为 Flow 额外创建私聊或独立任务产品。

## Skill 本地路径

App 内的 skill 可以使用：

```yaml
shell:
  - ${OPENGROVE_SKILL_DIR}/../../bin/example
paths:
  - ${OPENGROVE_SKILL_DIR}/../..
```

OpenGrove 会相对 mounted skill directory 解析这些值，所以私有 app 可以被 clone 到任意用户机器上，不需要改写 skill。

## 环境变量默认挂载

Headless 启动时，可以用 path-delimited 环境变量挂载 apps：

```bash
OPENGROVE_APP_DIRS="/path/to/app-a:/path/to/app-b"
```

`OPENGROVE_MOUNTED_APPS` 也作为等价名称接受。Settings UI 的修改会写入正常的 OpenGrove settings file。

## 完成与验证标准

一个 App 导入或创建完成时，agent 必须报告：

- OpenGrove 从哪里发现它，以及 Settings 里应启用哪个目录。
- `ui.surface` 是 `file-workbench`、`view` 还是 `none`；顶层 `view` 和 file-workbench 的每个 `view` tab 都必须使用标准 MCP App 合同，可交付 App 不得停在 `setup` 或使用不受支持的 UI kind。
- 输入文件、配置、模型/API/local dependency 分别是什么。
- 用户可见产物写到哪里。
- 暴露了哪些 CLI/skill/MCP/hook，哪些只是文档说明。
- 已执行的验证：manifest 解析、前端/服务端 typecheck 或 build、文件工作台写操作、CLI doctor/smoke 或真实 dry run。

如果某项验证因缺少密钥、模型或外部服务无法执行，必须明确写出缺的配置和可复现命令。
