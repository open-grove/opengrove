# App 发布 CLI（`opengrove app release`）

App 发布命令现在由 Host Protocol 统一生成。服务端、内部 TypeScript
Client、Web UI、CLI、OpenAPI 和外部 SDK 使用同一份契约，不再各自维护
HTTP、Bridge 发现、Cookie 或登录代码。

## 登录

先启动本机 OpenGrove Bridge，再使用全局统一登录态：

```bash
opengrove auth login --email admin@example.com
opengrove auth status
```

每个发布动作仍会在服务端检查当前账号是否是管理员。显式传入的
`--token` 优先于本机保存的账号会话。通用认证、错误和输出规则见
[`CLIENT_PROTOCOL.md`](../architecture/CLIENT_PROTOCOL.md)。

## 命令

```bash
opengrove app release prepare --app-id sample-app
opengrove app release publish --app-id sample-app --version 1.2.3 --yes
opengrove app release status --app-id sample-app
opengrove app release progress --app-id sample-app
opengrove app release reconcile --app-id sample-app
opengrove app release reconcile --app-id sample-app --retry-failed-build
opengrove app release abandon --app-id sample-app --yes
opengrove app release keep-local --app-id sample-app --yes
```

`publish` 还支持 `--release-notes`、`--visibility`、`--app`（JSON）和
`--employees`（JSON 数组）。没有显式提供的 App 元数据、可见性和员工配置
由服务端使用当前挂载 App 的基线值补齐。发布成功后默认把本机当前 App
切换到刚发布的正式版本；传 `--no-apply-to-current-app` 可以保留本机
现状（商店里仍会出现这个版本，供其他安装使用）。

## `publish` 如何走到终态

`publish` 请求返回时发布并没有结束。Release Control 在远端执行可信构建，
intent 依次经过 `awaiting_candidate → building → artifact_accepted →
finalizing → published`。`status` 只刷新远端状态；需要本地推一把的转换
（`awaiting_candidate`、`artifact_accepted`、`finalizing`，以及本地的
`registry-ready`）只有 `reconcile` 才会触发。Web 发布页会自动做这件事，
CLI 也一样：

- 默认情况下 `publish` 每 2 秒调用一次 `status`，在进度需要时自动调用
  `reconcile`，预算与 UI 相同（`artifact_accepted` 最多两次，其余转换一次）。
  当 `progress.state` 变为 `published` 或 `closed` 时以 `0` 退出，输出最终
  进度和 `wait` 摘要（`polls`、`reconciles`、`elapsedMs`）。
- 发布进入 `blocked` 或 `needs-retry` 时以 `1` 退出，stderr 带最后一次进度
  （`error.subtype: app_release_blocked`；读 `progress.buildFailure` 和
  `progress.allowedActions`，再决定 `reconcile --retry-failed-build` 还是
  `abandon --yes`）。自动预算用尽（`app_release_recovery_exhausted`）或超过
  `--wait-timeout`（默认 900 秒，`app_release_wait_timeout`）同样以 `1` 退出。
- `--no-wait` 立即返回第一份进度快照。使用它的调用方要自己轮询 `status`，
  并在 `remoteStatus` 为 `awaiting_candidate`、`artifact_accepted` 或
  `finalizing` 时调用 `reconcile`。
- `--poll-interval <seconds>` 调整等待期间的刷新间隔。

`reconcile` 随时可以手动执行：它会从 Bridge 日志记录的任意状态继续推进
当前 intent。

所有命令都支持 `--dry-run`，可在不发送请求的情况下完成校验并查看请求。
正式发布、放弃发布和保留本地修改属于高风险写操作，必须传 `--yes`。
通用参数还有 `--base-url`、`--token`、`--input` 和 `--format json`；
给具体命令传 `--help` 可以查看由契约生成的完整字段。

## 契约链路

源契约位于 `packages/protocol/src/apps.ts`，由它生成：

- 内部 `client.apps.releases.*` 方法；
- `opengrove app release ...` 命令树；
- `packages/protocol/openapi.json`；
- 外部 TypeScript SDK。

CI 会检查每个发布操作是否同时存在于 OpenAPI、服务端注册表、生成 Client
和 CLI 帮助中。Web 发布页面也已经改用生成 Client，并通过原有适配层保持
页面的错误恢复体验。

`src/tests/release-cli-harness.ts` 通过真实 HTTP socket 覆盖全部七个命令，
包括 dry-run、`--yes`、默认激活与 `--no-apply-to-current-app`、`publish`
等待循环（自动 `reconcile`、`--no-wait`、发布被阻塞、预算用尽、超时），
以及 `200`／`202` 两种成功响应。
