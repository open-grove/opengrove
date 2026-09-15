# 持续集成

[English](CI.md)

每类检查有明确的负责流程。PR 和 Main 共用 `.github/workflows/ci-checks.yml`；
`scripts/ci-check-plan.mjs` 选择执行项，`scripts/ci-harness-inventory.mjs`
管理确定性 harness 的归属。修改这两份来源，不在不同入口复制命令。

| 入口 | 负责内容 | 通过条件 |
| --- | --- | --- |
| PR / 合并队列 | 受影响的源码、集成、UI、原生文件系统和安装后启动检查 | `PR required`；所有选中的检查成功 |
| Main | 全部确定性源码、harness、UI 检查，以及原生平台和安装启动 | 精确提交的 `Main CI result` |
| Nightly（UTC 02:00 / 14:00）或手动 | 联网生产依赖安装、外部基准包可用性、真实 Agent 覆盖 | 每类检查成功，包括完整运行时证据 |
| 手动桌面候选 | 发布说明、基础设施、golden 回放、N-1 字节、签名产物、真实升级和源码身份 | 三平台完整候选及门禁回执 |
| Finalize / 登记 / 切换 | 将同一批已验证字节发布到已授权终点 | 既有制品与远端身份校验 |

纯文档 PR 检查链接；范围未知或无法取得时保守执行。选中的检查失败、取消或
跳过都会阻断；未选中的检查应明确跳过。Actions 定义使用固定版本、校验摘要的
actionlint 检查，行为测试覆盖范围选择、测试归属、前置条件顺序和证据拒绝。
确定性测试使用普通 Linux 用户与进程环境，仅运行时检查安装浏览器依赖。

Windows 和 macOS 在实际文件系统上执行共用集成集，Windows 另补发现、状态和
App 激活检查。清理验收使用既有回执，覆盖 junction、符号链接等情况。
Windows x64 和 macOS arm64 的独立打包 job 会构建、检查生成源码、准备依赖、
制作并安装安装包，要求 renderer/Bridge 就绪回执。无签名或临时签名只用于验证
启动；正式签名、公证、Intel Mac 打包与真实 N-1 更新仍由候选门禁负责。
构建后的源码检查用于尽早失败，最终源码清单检查用于保护产物身份，两者都保留。

Nightly 不再重复 Main 的 Linux harness、完整 UI 和 Web 包测试。临时生产依赖
`npm install` 属于联网集成，与仓库锁文件控制的 `npm ci` 分开。300 秒上限不变，
诊断记录打包／安装／导入阶段、平台、退出类别和耗时，不上传原始 npm 配置或凭据。
超时只能说明安装失败，不能等同于功能断言失败；先查原因，再决定是否重跑。

仓库变量 `OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT` 只提供公开下载根地址，应与
发布环境的同名配置一致；定时只读检查不进入受保护的发布环境。
基准健康检查验证固定历史 golden 与当前稳定版安装包的可访问性及预期大小，
不能代替字节校验。候选仍下载并回放 golden；同时在任何平台构建开始前取得
三个平台的 N-1 安装包。N-1 的大小和 SHA-256 来自稳定版 GitHub Release 资产清单
（首次公开发布使用已评审的 bootstrap）。平台 job 按 artifact ID 下载相同字节，
再次校验后交给真实 updater。

## 真实 Agent 配置与证据

必需的 Kernel、运行模式和能力组合来自生成的认证台账，历史认证行不视为本次执行。
仓库变量 `OPENGROVE_REAL_AGENT_IMAGES` 是按 Kernel ID 索引的 JSON 对象；每项包含
固定到 `ghcr.io/OWNER/IMAGE@sha256:DIGEST` 的 `image`，有意测试新引擎时可指定
`kernelVersion`，否则沿用台账版本。版本是完整发现字符串，不仅是 semver 前缀。
镜像清单检查和实际探针身份检查都执行；Claude SDK 使用锁文件安装的平台 Engine。

凭据放在 `opengrove-real-agent-test` environment：

- Claude/OpenCode 继续使用既有 Cloudflare 网关变量与 token。
- Pi 可使用 `REAL_RUNTIME_OPENAI_BASE_URL`、`REAL_RUNTIME_OPENAI_API_KEY`
  和 `REAL_RUNTIME_MODEL`。
- 可选 JSON secret `REAL_AGENT_RUNTIME_ENVIRONMENTS` 按 Kernel ID 提供受支持的
  厂商／OpenGrove 环境变量，仅传入探针子进程。Codex 测试配置、OpenClaw Gateway
  按各自真实鉴权协议配置；镜像不得包含凭据，定制 Hermes 构建需要独立固定镜像。

该入口负责接入已有环境，不会自动开通账号。缺镜像、凭据、服务、探针跳过或覆盖
不完整，都保持“未验证”。单 Kernel 手动诊断通过时流程可绿，但制品仍为
`ready: false`，不代表完整覆盖。旧的启用开关也不能
让跳过的矩阵满足发布要求。

只上传已通过泄漏检查的成功探针证据。汇总制品 `real-agent-coverage-RUN_ATTEMPT`
列出全部必需能力，并绑定 run、attempt、提交、运行模式和实际引擎版本。重跑失败
job 可复用同一 run/SHA 内未超过 24 小时的成功案例，按最新 attempt 取证；矩阵失败
仍不能满足发布条件。配置改变后需要新 run。发布资格
下载最新成功 Nightly 的制品、核对覆盖，并比较运行时／构建／探针源码输入摘要。
祖先提交足够新且相关输入一致时才复用；输入改变后必须重新运行 Nightly。
PR 不接收真实服务或签名密钥。

打包 job 无论成功失败都保留阶段耗时和门禁诊断。缓存用于加速输入，不能代替制品
身份或执行回执。优化以 Actions job 耗时和阶段记录为依据。

授权和可恢复发布终点见[发布流程](RELEASE_PROCESS.zh-CN.md)。
