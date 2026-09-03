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
由服务端使用当前挂载 App 的基线值补齐。发布成功后默认不切换当前 App；
只有显式传 `--apply-to-current-app` 才会激活刚发布的正式版本。

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
包括 dry-run、`--yes`、默认不激活，以及 `200`／`202` 两种成功响应。
