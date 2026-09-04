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

Nightly 证据证明近期祖先提交上的额外平台和真实服务健康状况，不要求它与
候选 SHA 完全相同。Nightly 之后的提交由精确 SHA 的 Main CI 和最终候选制品
门禁覆盖。

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
6. 运行能覆盖本次改动的针对性检查。

导入的旧基线只对 `legacyHostVersion` 指定的 Host 版本有效。新认证行会绑定
`hostVersion`、`kernelVersion` 与 `runtimeMode`；CI
能够检查其结构和可重复生成，但不会假装重新运行一套只在本机配置好的真实
Kernel。真实 Runtime 运行和原始 receipt 只作为本机未跟踪发布证据；人工复核后，
仓库中只保存导入器生成的最小认证批次。

### 汇总并确认发布说明

发布说明是针对完整变更区间的产品级总结，不是 PR 标题清单。起草前先生成
精确的审查清单：

```bash
npm run release:notes:context -- --from <previous-release-tag> --to HEAD
```

命令默认把可达的最新 tag 作为 `--from`。还没有公开 tag 的仓库必须显式传入
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

这个命令检查版本说明、发布配置与 workflow 契约，以及 npm 包清单。它不会
重复 Main CI 和 Nightly 已负责的完整 harness、完整 Browser UI、Web 包集成或
跨平台回归。

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

仅首次公开发布 `v0.6.6` 时，需要显式启用一次性引导参数：

```bash
gh workflow run desktop-release.yml --ref main \
  -f ref=<current-main-commit> \
  -f platforms=all \
  -f first_public_release=true
```

只有公开仓尚无任何 GitHub Release、且候选 tag 恰好为 `v0.6.6` 时，这条
路径才会被接受。它从受保护环境配置的正式发布根地址下载已审定的 `v0.6.5`
安装包，并逐项校验固定文件名、大小和 SHA-256 后，再执行正常的 N-1 更新
门禁。首个 GitHub Release 创建后，引导路径会被拒绝；后续候选会自动使用
公开仓的上一个 GitHub Release。

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
