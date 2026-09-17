# 发布流程

OpenGrove 桌面正式版由 CI 从明确的候选 commit 构建。通过门禁的同一批
字节会被最终化、部署和提升，下游阶段不会重建安装包。

## 不变条件

- 所有候选门禁通过前，不得创建正式版本 tag。
- workflow 必须从受信 `main` 启动。`ref` 只选择候选代码，不能替换
  `main` 上的 workflow 和 release-control 代码。
- 解析候选身份时，它必须等于当前 `main` 顶端。新的 `main` push 会取代
  旧的 Main CI 工作，并成为下一个可发版候选。
- 完整候选的精确 SHA 必须有最新且成功的 `Main CI` 运行记录。
- `main` 最近一次完成的 `Nightly` 必须成功、距今不超过 24 小时，且其
  测试 SHA 必须是候选 commit 的祖先。
- 只有 `platforms=all` 能组装可登记候选版本。局部平台运行仅用于诊断，
  不能提升。
- 一个版本由候选 commit、workflow run、version、`clientReleaseNumber`、
  不可变制品字节和 gate receipt 共同标识。
- 首个 schema v3 候选版登记前，WW 必须先执行本地化发布说明迁移，并部署支持
  schema v3 登记的服务。未就绪时严格失败是预期行为；不得为兼容旧发布控制服务而删掉
  本地化发布说明。

Nightly 负责外部服务、联网生产依赖安装和基准包可用性。发布资格还会下载完整
真实 Agent 覆盖制品，验证 run/attempt 身份及运行时输入摘要。近期祖先的相关输入
未变化时才可复用，否则必须重跑 Nightly。原生平台和无正式签名的安装启动检查由
精确 SHA 的 Main CI 负责。详见 [CI 职责与配置](CI.zh-CN.md)。

## 持续执行到已授权终点

`desktop-release-pipeline.yml` 按顺序调度既有候选、finalize、部署和切换 workflow。
输入为已授权的精确 `ref` SHA 与明确的 `stop_after`：`candidate`、`finalize`、
`register` 或 `promote`。默认停在候选；**停在登记之前**应选择 `finalize`。
普通 Main push 不会触发发布，启动前必须完成版本和发布说明准备。

编排从候选 SHA 读取版本及客户端发布编号，取得子 run ID 后立即保存，并在失败时
也上传 `release-progress-<run-id>-<attempt>`。恢复时使用同一 SHA 和原始
`resume_run_id`，明确选择这次授权的终点。编排先下载最近保存的进度，按候选 SHA、版本和发布编号校验身份；不同编排 run
对同一候选使用相同标识。随后验证已有子流程身份和结果，复用
成功记录；失败阶段不会自动重新发布，应先定位原因、按需要重跑该子 run，再恢复。
身份有歧义时拒绝继续。各阶段保留原来的 environment、权限、字节身份和远端核验；
已验收产物不重建，也不会越过选择的终点切换更新。

## 准备候选版本

1. 从干净、最新的 `main` 开始。
2. 更新 `package.json` 的 `version`，并递增 `clientReleaseNumber`。
3. 刷新所有 `legacyHostVersion` 已不匹配候选版本的 Kernel 能力证据：
   在该候选版本上运行真实 Runtime 探针，使用
   `scripts/import-kernel-evidence-receipt.mjs` 只导入通过的最小认证行，
   再运行 `npm run generate:kernel-evidence` 和
   `npm run test:capabilities`。不得通过延长旧迁移版本或手改生成账本来继续
   宣称能力可用。
4. 按下文流程汇总并确认双语发布说明，然后成对添加
   `docs/releases/vX.Y.Z.md` 和 `docs/releases/vX.Y.Z.zh-CN.md`。
5. 更新 `CHANGELOG.md`。
6. 运行能覆盖本次改动的针对性检查，并完成 [Claude Auto 验收](#claude-auto-验收)。

导入的旧基线只对 `legacyHostVersion` 指定的 Host 版本有效。新认证行会绑定
`hostVersion`、`kernelVersion` 与 `runtimeMode`；CI 验证其结构和可复现性，
并要求已配置测试镜像与服务对每个认证组合执行新探针。本地原始回执不提交，只有
经评审的最小认证批次通过 importer 进入仓库；历史行不能代替 Nightly 的覆盖制品。

### Claude Auto 验收

OpenGrove 对 Claude SDK 统一提供 Auto，不在界面和员工管理流程中逐模型判断支持情况。
发布候选版本前，在临时 Workspace 中，用候选版本的 SDK/引擎和支持的 Provider 路由，
逐一验证正式支持的 Claude 模型：

- 选择 Auto，确认原生会话成功切到 `auto`。
- 执行固定、无害的工具操作，确认原生自动审批完成；同时确认该操作在 Ask 下可以请求
  人工决定。仅成功返回一条模型回复，不代表自动审批已验证。
- 如果回退到 Ask，即使对话成功，也不能算 Auto 验收通过。
- 在发布证据中记录候选 SHA、SDK/引擎版本、模型 ID、Provider 路由和结果。
  未通过时先修复路由或调整支持范围，不把模型探测和缓存判断放回用户日常操作中。

这是发版前的真实运行验收。单元测试和普通 CI 不能代替它，也不会自动使用开发者的凭据。
验收不修改用户已经保存的权限。

### 汇总并确认发布说明

发布说明是针对完整变更区间的产品级总结，不是 PR 标题清单。起草前先生成
精确的审查清单：

```bash
npm run release:notes:context -- --from <previous-release-tag> --to HEAD
```

命令默认把可达且匹配 `v*` 的最新 tag 作为 `--from`。还没有公开 tag 的仓库必须显式传入
经过审定的发布边界 ref。输出包含 first-parent 历史、全部 commit、所有变更路径和
diff 摘要。它是输入清单，不会自动生成发布文案。

准备发布的 Agent 必须检查该精确区间内的每一项已合并变更，包括实际 diff 和可获取的
关联 PR。在 Codex 对话中，它需要在内部把变更分为产品体验、技术改进或省略，再把
多个 PR 中相关的工作合并成少数几个完整主题，并说明重要省略项。PR 与主题的
对应只是审查证据，不应写入公开 Release，也不应作为逐 PR 永久清单提交到仓库。

双语文档必须严格只有以下两个公开大节，且顺序一致：

```markdown
## Product Updates

## Technical Improvements
```

```markdown
## 产品更新

## 技术改进
```

`产品更新` 用使用者能直接理解的语言描述结果；`技术改进` 汇总架构、兼容性、稳定性和
贡献者相关工作，但不按 PR 逐条复制。中英文必须表达同一组事实，不是两份独立的更新日志。

`产品更新` 应保持纯文本也能读懂：v0.6.5 及更早客户端直接显示旧的英文
`release_notes` 字段，不渲染 Markdown。在仍支持这些客户端时，应少用行内强调和链接。
旧字段必须等于本地化英文 Markdown，因此不能另外生成纯文本版本。每种语言提取后的
`产品更新` 上限为 65,535 个 UTF-8 字节；当前版本双语文件都存在时，普通 CI 也会校验格式和长度。

在写入文件前，Agent 必须先在 Codex 对话中展示完整中英文草稿，并等待用户明确确认。
确认后再写入成对文件并提交发布准备 PR；该 PR 合并后，文案就被冻结在候选 commit。
CI 只校验两节契约，并把两种语言的 `产品更新` Markdown 提取到桌面更新 metadata；
不会重新生成或改写已确认的文案。GitHub Release 仍使用两份完整文档，包括 `技术改进`。
Gate receipt schema v3 会在登记到 WW 前，用一个 SHA-256 摘要绑定已确认的 `en` 和 `zh-CN` 字节。

候选 workflow 会先验证精确 SHA 的 Main CI 和近期 Nightly 证据，然后对已授权
的候选 commit 执行必需的轻量发布就绪检查：

```bash
npm run release:readiness
```

这个命令检查正式发布说明与 npm 包清单。发布配置和 workflow 契约已在精确 SHA
的 Main CI 通过；候选专属的基础设施、签名、基准和安装门禁仍独立保留，不重复
源码 harness、UI 和 Web 包检查。

如果希望在启动云端候选版本前，提前排除可确定复现的源码和发布资料问题，
可以选择运行：

```bash
npm run release:check
```

这是比候选 workflow 更广的本地信心检查。它可能生成临时 Web 和 npm 包制品，
但不会构建、签名、安装或上传桌面安装包，不会访问本机签名身份，也不会下载
上一版。该检查完全可选，不能代替已记录的 Main CI 和 Nightly 证据。

## 构建与门禁

从 `main` 启动受信候选 workflow：

```bash
gh workflow run desktop-release.yml --ref main \
  -f ref=<current-main-commit> \
  -f platforms=all
```

仅首次公开发布 `v0.7.0` 时，需要显式启用一次性引导参数：

```bash
gh workflow run desktop-release.yml --ref main \
  -f ref=<current-main-commit> \
  -f platforms=all \
  -f first_public_release=true
```

只有公开仓尚无任何 GitHub Release、且候选 tag 恰好为 `v0.7.0` 时，这条
路径才会被接受。它从受保护环境配置的正式发布根地址下载已审定的 `v0.6.5`
安装包，并逐项校验固定文件名、大小和 SHA-256 后，再执行正常的 N-1 更新
门禁。首个 GitHub Release 创建后，引导路径会被拒绝；后续候选会自动使用
公开仓的上一个 GitHub Release。

已知良好制品重放使用独立固定的 `v0.6.0` 基线。候选 workflow 从已通过连通性
检查的正式发布根地址读取该历史安装包，再校验原有文件大小、SHA-256 和 dist
inventory。它不要求公开仓补建历史 GitHub Release，也不会改变 N-1 更新所用的
`v0.6.5` 引导制品。独立运行重放 workflow 时可传入 `public_root`；省略时仍使用
GitHub Release 资产。

只有以下门禁全部通过，workflow 才会组装不可变候选版本：

- 版本号和成对版本说明；
- 候选精确 SHA 最新且成功的 Main CI；
- SHA 位于候选历史中、近期且成功的最新 Nightly；
- 用固定的已知良好制品重放安装包与 Bridge 门禁；
- 已签名/公证的 macOS Apple Silicon 和 Intel 包；
- Windows x64 包；
- package inventory 与最终安装制品 smoke；
- 独立生成并验证的 updater metadata；
- 从上一个已发布版本升级的真实行为；
- 对精确平台字节生成的统一 gate receipt。

`platforms=windows-x64` 等单平台运行可用于诊断，但不会生成可登记
候选版本或 gate receipt。

### 存储管理改动的真实文件系统验收

改动递归清理或本地缓存策略时，除自动化门禁外还必须记录对应平台的
真实文件系统验收结果。可在本地机器或 GitHub 托管的 Windows/macOS runner 上执行，
但必须运行产品实际使用的清理代码并创建原生文件系统链接。验收应使用临时测试数据，
并在操作前后核对作品、对话、设置、账号、
知识库、当前 App 和诊断日志的保留情况。

- Windows（不可恢复风险，必测）：在 OpenGrove 清理范围内创建指向范围外测试目录
  的 directory junction，执行实际使用 `fs.rm` 的清理路径；确认不会跟随 junction 删除
  范围外文件。该项不得只用普通符号链接或 mock 代替。
- macOS：在 OpenGrove 清理范围内创建指向范围外测试目录的符号链接，
  确认清理不会跟随链接或删除范围外文件。

结果必须注明候选 SHA、客户端版本、操作系统版本、文件系统、测试目录、操作前后
校验值和操作结果，并区分本地机器与 GitHub runner。PR/Main 的原生平台 job 执行
清理验收，上传 `storage-cleanup-<platform>-<run-attempt>`
验收回执；Windows 会验证 NTFS 和 Junction 类型。该证据只覆盖文件系统清理行为，
不代表实体电脑上的安装或界面验收。未执行的项目必须在发布记录中写明，
不能把 mock、静态检查或其他测试通过记作本项通过。

只有证据表明失败来自瞬时基础设施、且候选代码没有变化时，才可以仅重跑
失败 job：

```bash
gh run rerun <run-id> --failed
```

可确定复现的产品、测试、签名、公证、打包、metadata 或 updater 失败，
必须提交修复、产生新候选 commit，并重新运行完整候选流程。

## 最终化、部署与控制

完整候选版本的所有门禁通过后：

1. 用候选 run ID 和预期 tag 启动 `desktop-release-finalize.yml`。它会验证
   候选身份、下载通过门禁的候选版本，在精确 commit 上创建正式 tag，并把
   同一批字节附到 GitHub Release。
2. 用同一 run ID 和 tag 启动 `desktop-release-deploy.yml`。它会下载、校验、
   上传并登记同一批门禁字节，不重建，也不修改活跃更新指针。
3. 用 `desktop-release-control.yml` 显式执行 `promote`、`rollback`
   或 `withdraw`。

Rollback 只重新指定合格客户端后续会收到哪个版本，不强制已安装更新版的
客户端降级。Withdraw 清空当前活跃候选版本。两者都不删除不可变候选版本、
tag、GitHub Release 或已保留制品。

部署 endpoint、账号标识、bucket 名、签名材料和访问 token 只能通过受保护的
GitHub environment、variables 和 secrets 提供。不得把它们的真实值写进跟踪文件、
issue/PR 日志或要公开的本地证据。
