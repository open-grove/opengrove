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

Claude 统一通过 Agent SDK 运行，旧 `OPENGROVE_CLAUDE_CODE_RUNTIME` 开关不再生效。
SDK 仍会启动 Claude 引擎，原生 Login 命令也需要该程序，因此保留引擎查找和
`OPENGROVE_CLAUDE_CLI_PATH` 路径配置。

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

真实 runtime 验证一旦通过，其正面结论就会保留。Kernel 版本、runtime mode
或 Provider 变化只会触发当前上下文复验，不会自动对用户隐藏能力。只有当前上下文下
更新的失败验证，或显式的 `not-wired` / `suppressed` contract mapping，才会撤销暴露。

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

## 三档权限

员工（包括全局 PM 和 App 内绑定的 PM）与聊天共用三个选择：**请求批准**（`default`）、
**帮我批准**（`auto-review`）、**完全访问权限**（`full-access`）。档位选择不改变员工的
App、Workspace、工具可见范围或管理员身份。原生工具由内核审批；Host 工具仍执行 App 的策略。

| Kernel | 请求批准 | 帮我批准 | 完全访问权限 |
| --- | --- | --- | --- |
| Codex | `workspace-write` + `on-request` + reviewer `user` | 同样的沙箱与策略，reviewer `auto_review` | `danger-full-access` + `never` |
| Claude Agent SDK | `default` | `auto`，发送任务前等待原生 `setPermissionMode` 成功 | `bypassPermissions` + `allowDangerouslySkipPermissions` |
| Hermes | `approvals.mode: manual` | `approvals.mode: smart` | `HERMES_YOLO_MODE=1`；隔离配置同时设置 `approvals.mode: off` |
| OpenCode | 读取允许，其余默认询问；保留显式 deny | 不可用 | 普通操作允许；保留传入配置中的显式 deny |
| Kimi | ACP 请求交给用户决定 | 不可用 | 对普通 ACP 权限请求选择 `allow_once`；问题仍交给用户 |
| Pi | Host 工具策略与原生工具 hook 询问 | 不可用 | 允许普通工具操作；明确拒绝规则继续生效 |
| OpenClaw | 由 Gateway 管理 | 不可用 | 不可用，尚未接通员工级权限控制 |

Codex 前两档都关闭沙箱内网络访问，写入 Workspace 之外或联网需要走原生审批。
`on-failure` 和 Claude `acceptEdits` 都不代表“帮我批准”。
Claude Opus 5 和 Opus 4.8 按[原生模型要求](https://code.claude.com/docs/en/permission-modes#eliminate-permission-prompts-with-auto-mode)
直接声明支持自动审查；DeepSeek v4 Flash 通过 Claude Agent SDK 使用 OpenGrove Provider 时也明确支持。
这些模型没有缓存或缓存过期也可选。其他模型及别名使用 SDK 模型记录；原生默认模型
使用 `default` 记录及其解析后的型号，支持情况未知时置灰。执行时直接开启原生模式，不等待模型列表查询；
开启失败显示原因及恢复方法：改选请求批准，或修正服务商/账号配置；不会偷偷改动已保存的权限。
实际模式不是 `auto` 时拒绝继续。模型资料刷新在开启操作之前启动，不等待列表返回，供选择器使用。
Claude 执行统一使用 Agent SDK。
创建员工、同步内置员工、权限迁移、导入 App 和恢复 App 默认设置时，与权限选择器读取同一个
Claude 配置目录中的缓存。自定义 `kernelPathOverrides["claude-code"].configHome` 同时用于判断
选项是否可用和计算默认档位。

Hermes 按环境与档位隔离进程，生成配置副本时保留用户的 deny 与辅助审查模型配置。
完全访问使用原生 YOLO 开关，覆盖那些不读取 `approvals.mode` 的审批入口；原生硬性阻止与用户明确
禁止的规则仍然生效。请求批准和自动审查通过公开 `config.get` RPC（desktop contract v3+）核对有效
模式，自定义 gateway 命令也需要通过。接口不可用或模式不一致时，在提交用户输入前停止，并说明如何
更新 Hermes 或调整配置。

没有 Provider 覆盖时，显式 `HERMES_HOME` / `OPENGROVE_HERMES_HOME`，或
`OPENGROVE_HERMES_ISOLATED_HOME=0` 会使用原生目录、保留其中的数据。该目录的审批配置须与员工
选择的请求批准/自动审查档位一致，OpenGrove 不改写它。设置 `OPENGROVE_HERMES_ISOLATED_HOME=1`
则使用配置副本；Provider 覆盖始终使用副本。副本是临时的，初始化失败、gateway 退出及运行时关闭时
都会清理，不提供跨进程的原生会话持久化。启动时也会清理已记录归属、且 Host 与 gateway 进程均已
退出的临时副本；归属不明或无法确认启动结果时保留。原生目录交给 Hermes 自行读取，不额外套用
Host 的 YAML 校验。未传权限档位时保留原生审批及 YOLO 设置，生成副本时也遵循此规则。
需要生成副本时，YAML 损坏或凭据不可读会给出明确错误，不回显配置正文。
阻塞审批和用户问题分别接入，兼容 desktop contract v7 的 server request 与此前的通知协议。
未回答的审批默认五分钟后拒绝；取消、回合结束和 gateway 退出会结束等待中的请求。
用户问题仍需人工回答，所属回合结束时取消。

执行 `npm run build:server` 后，可运行 `node scripts/certify-hermes-permissions.mjs [hermes-command]`，
用临时目录验证三档原生配置、完全访问、人工拒绝及用户禁止规则。该契约检查不调用模型、不执行工具命令，
也不评价 smart 模型的审查结果。这些权限行为已针对 Hermes `v2026.9.7` 验证。

全局 PM 及各 App 内的 PM 绑定默认使用**帮我批准**，继续使用 Claude Agent SDK 和 DeepSeek v4 Flash。
这个明确的产品默认值不依赖本机模型缓存；仍须成功启用原生 Auto 后才提交用户输入。其他新员工和聊天优先选择**帮我批准**：
Codex、Hermes 默认 auto；Claude Opus 5、Opus 4.8 和 DeepSeek v4 Flash 按上述声明默认 auto，其他 Claude SDK 模型
需要缓存确认支持，否则新员工默认请求批准；
Pi、Kimi、OpenCode 默认请求批准。OpenClaw 仍由 Gateway 管理，远程权限由远端决定。

普通 seed 同步中，用户明确选择优先于 App 声明，兼容的 App 声明优先于产品默认值。
App 版本激活和主动恢复 App 默认设置可以重新应用 App 配置。普通同步也保留所有内置员工（包括 PM）已保存的权限；
App 默认快照与用户当前选择分开保存。恢复默认读取 App 声明；App 未声明权限时采用产品默认值，不采用用户上次选择。
App 没有声明权限档位或声明未改变时，保留该 App 员工已保存的权限。系统迁移不产生“用户修改过”的
标记；App 声明发生变化时仍可应用新默认。对没有支持声明的模型，Claude 缓存刷新或丢失
可能影响选项是否可用、以及新员工的默认档位，不改写已有选择；内核不支持的组合仍会修正。
v4 迁移只执行一次：对支持 Auto 的本地员工，将请求批准升为帮我批准，包括用户明确保存的请求批准；
已有的帮我批准和完全访问保持不变。迁移先转换旧模型标识，在修改前备份状态，并把完成标记与员工数据
一起原子保存到 SQLite/JSON。设置文件缺失或损坏不会跳过尚未执行的迁移，也不会重复已完成的迁移；
旧数据首次建立该记录时沿用设置中已保存的迁移版本。
缺失权限和不支持的组合仍会归一化。
迁移后用户再改回请求批准，重启也会保留；App 内的 PM 绑定跟随全局 PM。
聊天读取已有选择时不改写；没有选择时根据当前内核和模型决定默认档位。

不支持的档位在选择器中禁用、运行入口拒绝。员工保存和 API 写入同时核对所选模型；切换模型后若
Auto 不可用，修改先留在草稿中，待用户选择有效权限后，将模型和权限一起保存。API 传入权限 `null`
表示恢复跟随 App/产品默认，并移除用户覆盖标记。从 auto 切换到 Pi、Kimi 或 OpenCode 时，自动改为
请求批准并显示提示。员工创建、更新、App 导入和 seed 同步使用同一条兼容规则；发布时拒绝不支持的组合。
Claude 本机尚未确认模型支持，与内核本身不支持不同，不因此拒绝可移植 App 的权限声明。

Codex 三档的映射与未指定档位的调用分开：没有传 `accessMode` 时保留原有审批和沙箱配置，
没有其他配置时仍回落到 `danger-full-access` / `never`；未传档位时，线程和每轮执行均不覆盖原生网络配置。
Claude 未传档位时保留已有配置，无配置则回落到 `bypassPermissions`。这些 API 兜底与产品默认选择分开。
Claude 原生默认模型根据 SDK 的 `default` 记录判断；首次没有缓存时，
需通过普通运行刷新模型支持信息。

参数契约回归：[`runtime-access-modes.test.ts`](../../src/tests/runtime-access-modes.test.ts)。
协议依据：[Codex desktop 预设](https://learn.chatgpt.com/docs/sandboxing)、
[Claude SDK 权限](https://code.claude.com/docs/en/agent-sdk/permissions)、
[Hermes 审批实现](https://github.com/NousResearch/hermes-agent/blob/main/tools/approval.py)。

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
