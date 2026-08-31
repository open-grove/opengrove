# Kernel 接入指南

本文介绍如何把原生 Agent SDK、CLI、JSON-RPC 服务、ACP 子进程或 Gateway
接入 OpenGrove。目标是保留 Kernel 的原生模型循环，只投影 Host 和 UI 必须理解的
部分。

## 职责边界

- **Kernel** 负责模型循环、原生工具、认证、transcript、compaction、Provider
  行为和原生权限语义。
- **Host** 负责 OpenGrove sessions/Rooms、本地状态、Apps、approvals、artifacts、
  显式上下文、诊断和产品策略。
- **Adapter** 负责 transport、事件投影、稳定的 native-session binding、能力声明，
  以及 native request 与 Host control 之间的转换。

不要在 Host 内重写 Kernel 循环，不要把 Host 历史重放进 Kernel-owned transcript，
不要绕过 `KernelAdapter` / `AgentRuntime` 直接更新 UI；协议有结构化事件时，
不得改用日志解析替代。

公开契约定义在
[`src/kernel/types.ts`](../../src/kernel/types.ts)、
[`src/kernel/adapter.ts`](../../src/kernel/adapter.ts) 与
[`src/kernel/adapters/`](../../src/kernel/adapters/) 下的 Kernel-specific 文件。

## 选择最窄 transport

优先使用 Kernel 官方支持的 programmatic boundary：

| 形态 | 当前参考 |
| --- | --- |
| JSON-RPC service | Codex：`src/runtime/codex/app-server-client.ts` 和 `src/runtime/codex/event-projector.ts` |
| In-process SDK | Claude Agent：`src/runtime/claude-agent-sdk-runtime.ts`；Pi：`src/runtime/pi-runtime.ts` |
| ACP 子进程 | 共享 runtime：`src/runtime/acp-cli-runtime.ts`；OpenCode/Kimi adapter 位于 `src/kernel/adapters/` |
| Gateway | Hermes：`src/runtime/hermes-runtime.ts`；OpenClaw：`src/runtime/openclaw-gateway-runtime.ts` |

只有上游没有结构化边界时才回退到通用文本 CLI。Tool lifecycle、approval、
session identity、usage 和 error 都应以原生协议事件为真相源。

## 最小闭环

新接入必须先证明以下闭环：

1. Host turn 携带选定模型、显式上下文、附件和 runtime controls 进入原生 runtime。
2. 初始化记录 native version、session identity 和安全诊断。
3. 原生回答 delta 映射为 `assistant.delta`。
4. 最终回答在唯一 `turn.finished` 前映射为唯一 `model.response`。
5. 错误和取消同样必须用 `turn.finished` 关闭 stream。
6. 每个对产品声明的 native tool、Host tool、approval、question、steering 或
   compaction 能力都有真实 mapping 和 harness 断言。
7. fake runtime 不调用网络或真实账号即可验证 mapping。

共享事件契约 harness 在
[`src/tests/kernel-event-contract-harness.ts`](../../src/tests/kernel-event-contract-harness.ts)
检查 terminal 顺序、重复输出和可关联 tool progress。

Runtime 契约仍要求恰好一个 `model.response`。在 Host 边界，
`KernelAdapter` 会保留已有的 `assistant.final`，或在 `turn.finished`
之前从非空 `model.response` 派生一个，不会重复生成 final event。
`collectAssistantText` 恢复 helper 在需要直接读取 event sequence 时，
会优先使用 `assistant.final`，其次是 `model.response`，最后才是
累积的 `assistant.delta` 文本。

## Adapter contract

每个 adapter 都应在实现旁定义 `KernelAdapterContract`，明确：

- sessions、loop、native/Host tools、approvals、questions、skills、context、
  compaction、auth、sandbox、transport 和 diagnostics 的归属；
- native-to-Host 和 Host-to-native event mappings；
- diagnostics capture mode 与脱敏策略；
- config、executable、native skill 与 knowledge paths；
- model display alias 与 input template；
- 用户可见 labels。

Capability flag 是对产品的承诺。上游 Kernel 文档提到某能力，不等于当前
adapter 已支持；只有 adapter 真正暴露且 contract test 覆盖时才能标记支持。
Capability catalog、UI 行为和 report 的真相源是
[`src/kernel/capabilities/native-facts.ts`](../../src/kernel/capabilities/native-facts.ts)、
[`docs/reference/KERNEL_SOURCES.md`](KERNEL_SOURCES.md) 和
[`web/src/runtime/kernel-capability-ui-policy.ts`](../../web/src/runtime/kernel-capability-ui-policy.ts)。

## 事件投影

为原生协议维护明确 mapping，至少覆盖：

| 原生边界 | OpenGrove 事件 | 要求 |
| --- | --- | --- |
| query/turn start | `turn.started` | 每个 run 只有一个 lifecycle start |
| assembled request | `context.assembled` / `model.requested` | 保留 model、session、tools、skills 和显式 context 元数据 |
| text delta | `assistant.delta` | 增量流式发送，不等 final result |
| tool start/progress/result | `tool.started` / `tool.progress` / `tool.finished` | 保留 native tool id 和 call id |
| permission request | `approval.requested` | 等待 Host 决定，再回答同一 native request |
| final response | `model.response` | 只发一次；只能按明确约定用累计 answer text 回退 |
| error | `error` | 脱敏凭据和私有 payload，只保留安全的上游关联 id |
| run end | `turn.finished` | 成功、失败、取消、中断都只发一次 |

同一 run 的所有事件使用同一 `runId`，tool progress 必须能关联到已启动
call。仅用于诊断的数据不得渲染成对话文本。

## Session 与 runtime binding

OpenGrove session id 和 native session id 是两种身份。Adapter 必须保存 native
binding；原生 transcript 存在时真实 resume，不存在时如实新建，不能伪装恢复成功。

所有会改变 transcript 兼容性的输入都应纳入 runtime binding fingerprint，例如
Kernel、working directory、App/version scope、Provider route 和关键 runtime 配置。
Fingerprint 变化时不得静默复用不兼容的 native transcript。

## Tools、approval 与 elicitation

这些能力按 adapter 分别声明：

- Native tools 由 Kernel 执行；Adapter 只投影 lifecycle，不重复执行。
- Host tools 必须通过 dynamic tools 或 per-session MCP server 等明确 bridge，输入输出
  必须 JSON-compatible 且有界。
- Native permission request 必须等 OpenGrove approval 决定，同一 native turn 才能继续。
- 协议有结构化 elicitation 时才声明 question 支持，不得把文本 fallback 冒充原生能力。
- 拒绝、超时、取消和进程退出都必须正常收尾，不得留下 pending run/approval。

## 诊断与隐私

有用的诊断包括 runtime version、安全的 executable source、native session id、
model id、permission mode、已暴露 tool 名、bridge state，以及 Provider 真正返回的
request id。

不得记录 API key、OAuth token、cookie、完整 request header、未脱敏 Provider payload、
私有 reasoning、无关环境变量，以及不是用户自身诊断所必需的本机路径。Harness
fixture 应使用生成的临时目录和假凭据。

## 验证

在 `src/tests/` 下添加 fake-runtime harness，覆盖成功、失败、取消、resume 和所有
已声明交互能力。先从窄验证开始：

```bash
npm run build:server
node dist/tests/<kernel>-runtime-harness.js
npm run test:capabilities
```

改动影响 kernel selection、Rooms、打包或共享事件契约时，再扩大到 `package.json`
中对应 integration group。Real-runtime probe 是附加证据，可能需要本地凭据；
它不能取代确定性 harness，生成证据也不能提交。

## 完成标准

- 能通过选定 Kernel 完成一次真实 turn。
- Fake harness 覆盖 lifecycle、output、error、resume 和已声明 tool/approval/question/control 路径。
- `KernelAdapterContract` 明确 ownership、events、paths、diagnostics 和 labels，不依赖生成的 fallback 字段。
- Capability facts 引用已安装 package types 或固定版本官方来源，不复制第三方源码 snapshot。
- Native session 复用受 binding 保护，resume 失败对用户可见。
- 取消或拒绝不会让 turn 卡住。
- 本地 Kernel 循环不依赖 cloud-only 服务。
- 原生凭据和本地 runtime evidence 不进入 tracked files 或可分发 App。
