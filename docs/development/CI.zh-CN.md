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

普通文档路径只用 Node 检查链接，不安装应用依赖、不构建。运行时技能、提示词和
fixture 中的 Markdown 属于产品输入。范围未知或 diff 不可用时保守执行。
PR 的 harness 集合是“基础集成检查 + 受影响模块的测试归属”的并集，Main 执行全部
归属。`src/tests/*-harness.ts` 必须登记，同一环境的重复执行项会被清单检查拒绝。
Windows 开发命令和原生 job 共用同一份记录；Node 单测负责 `*.test.js`，Server
静态检查不再重复执行 Host 契约单测。

任务声明准备需求，harness job 构建一次后执行选中的测试。离线包内容检查验证技能
与 import 目标是否进入发布包，合并前就运行；联网安装留在 Nightly。
跨 OS、源码运行与安装后运行属于不同场景。原生和安装包检查暂时保守选取，后续根据
实际耗时与回归数据细化，不能仅为缩短时间删掉平台。

选中的检查必须成功，失败、取消、跳过都阻断；未选中的 job 应明确跳过。
Actions 定义使用固定版本和校验摘要的 actionlint 检查，行为测试覆盖选择、恢复和
证据拒绝。

Windows 和 macOS 在实际文件系统上执行共用集成集，Windows 另补发现、状态和
App 激活检查。清理验收使用既有回执，覆盖 junction、符号链接等情况。
Windows x64 和 macOS arm64 的独立打包 job 会构建、检查生成源码、准备依赖、
制作并安装安装包，要求 renderer/Bridge 就绪回执。无签名或临时签名只用于验证
启动；正式签名、公证、Intel Mac 打包与真实 N-1 更新仍由候选门禁负责。
构建后的源码检查用于尽早失败，最终源码清单检查用于保护产物身份，两者都保留。

Nightly 不再重复 Main 的 Linux harness、完整 UI 和 Web 包测试。临时生产依赖
`npm install` 属于联网集成，与仓库锁文件控制的 `npm ci` 分开。300 秒上限不变，
诊断记录打包／安装／导入阶段、平台、退出类别、耗时和经过筛选的 npm 下载／生命周期／
计时指标，不上传原始日志、npm 配置或凭据。
超时只能说明安装失败，不能等同于功能断言失败；先查原因，再决定是否重跑。

仓库变量 `OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT` 只提供公开下载根地址，应与
发布环境的同名配置一致；定时只读检查不进入受保护的发布环境。
基准健康检查验证固定历史 golden 与当前稳定版安装包的可访问性及预期大小，
不能代替字节校验。候选仍下载并回放 golden；同时在任何平台构建开始前取得
三个平台的 N-1 安装包。N-1 的大小和 SHA-256 来自稳定版 GitHub Release 资产清单
（首次公开发布使用已评审的 bootstrap）。平台 job 按 artifact ID 下载相同字节，
再次校验后交给真实 updater。

## 真实 Agent 配置与证据

[`scripts/ci/real-agent-support.json`](../../scripts/ci/real-agent-support.json)
独立定义必测 case、模式、能力与模型接入配置。这是要求清单，不是成功证明；历史
认证不随 CI 结果手改。新增能力或登录方式，需要明确 case 与对应实现才能认证。

仓库 JSON 变量 `OPENGROVE_REAL_AGENT_IMAGES` 按 **case ID** 索引（目前为七个
Kernel ID）。每项必须指定 `ghcr.io/OWNER/IMAGE@sha256:DIGEST`，可显式覆盖
`kernelVersion`、`model`、非敏感的 `configRevision`；默认版本与模型来自支持清单。
版本必须是完整发现身份。轮换凭据或修改外部配置时递增 `configRevision`，不得公开
凭据或原始 secret 的哈希。配置变化会使相应计划失效。
镜像回执单独记录 `cliVersion`，不能直接当作所有运行模式的发现身份；例如 OpenClaw
Gateway 握手返回的版本与 CLI 显示文字不同。

执行计划固定源码输入摘要、测试策略、case、模式、版本、镜像、供应商、协议、模型和
配置代次。测试按这份计划执行，汇总与发布再次核对，不能只验证版本非空。
源码和依赖范围保持保守；无关脚本和 Web UI 不使真实认证失效。每项 case 从实际执行
时间起有效 24 小时，重跑汇总不会延长它的有效期。

当前认证配置使用 `opengrove-real-agent-test` environment 内的 `DEEPSEEK_API_KEY`。
模型由计划指定；`REAL_AGENT_RUNTIME_ENVIRONMENTS`、旧 Cloudflare/Pi 引导变量和
`DEEPSEEK_MODEL` 不再隐式覆盖认证配置。其他供应商应新增明确的支持配置和 runner
实现。Claude 走 Anthropic，Codex 走 Responses，其余保留各自的 OpenAI 兼容接入；
OpenClaw 启动独立 Gateway。API Key 可用不能证明原生账号专属能力。

镜像流程支持六个 npm Kernel 和源码固定的 Hermes，发布前校验实际镜像，分别展示本地构建摘要和已发布的
不可变仓库引用；只有后者可填入映射。Hermes 必须指定完整的 `source_revision`，按上游锁文件安装 Python 依赖，使用官方
构建 SHA 机制避免本机分支元数据改变版本显示，并核验实际源码身份。
Claude SDK 使用锁文件安装的 Engine 并核验身份。镜像不包含凭据。
完整门禁启用前必须配置仓库对 GHCR 包的 Actions 访问权限，取得全部要求的真实成功
记录。缺镜像、权限或能力失败都会阻断，确定性 CI 通过不能代替在线验收。

手动单 Kernel 运行仅用于诊断，不能代替完整 Nightly。
`exploratory: true` 使用独立的 `OPENGROVE_REAL_AGENT_EXPLORATORY_IMAGES` 映射
测试新的固定版本，其执行目的和计划不能满足发布认证。PR 不接收模型或签名密钥。

成功探针先通过泄漏检查再上传；失败只保存安全的 case 身份、阶段、错误类别和耗时，
明确标记不成功。各 case 保留实际 run/attempt 与不可变 artifact ID；后来的失败
不能被旧成功覆盖。

最后的 **Nightly result** job 生成 `nightly-release-evidence-RUN_ATTEMPT`。
只重跑其他失败分支时，它也会重新汇总，复用同一 run/SHA 中仍有效的早期 case。
缺失、过期、错误输入和失败仍阻断，最终汇总必须属于当前 attempt。
发布同时根据当前仓库配置重新解析计划，模型或镜像改变后旧认证失效。
祖先提交只有在相关输入完全相同时才能复用。外部安装包可用性、安装包 SHA-256 和
Agent 能力证据分别验证；网络恢复不会刷新旧 Agent 成绩的时间。

## 诊断与维护

每个 harness 有独立超时和进程清理责任，`test-results/ci/` 记录退出类别、超时／
取消、耗时、平台与 Node 版本。版本探测或初始化失败会写失败结果并清理资源，
不再丢弃本轮其他结果。Playwright 保留 JSON、HTML 报告，重试变绿也上传结果；
失败与不稳定测试的 trace、视频遵循 Playwright 保留规则。重试成功不等于根因修复。

外部 Actions 固定完整提交 SHA，CI 自动检查，Dependabot 每周维护并限制同时打开的
更新 PR 数。CodeQL 对 Actions 与 JavaScript/TypeScript 按事件扫描一次，不应再
开启重复的默认扫描。仓库管理员负责必需检查、CODEOWNERS、绕过权限和凭据范围，
不能单凭 YAML 断言后台设置。正式发布保留受保护环境与现有鉴权协议，仅在目标服务
支持时使用 OIDC。

打包 job 无论成功失败都保留阶段耗时和门禁诊断。缓存用于加速输入，不能代替制品
身份或执行回执。优化以 Actions job 耗时和阶段记录为依据。

授权和可恢复发布终点见[发布流程](RELEASE_PROCESS.zh-CN.md)。
