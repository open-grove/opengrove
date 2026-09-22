# 本地产品接入

[English](LOCAL_INTEGRATION.md)

剪辑软件、网页和插件可以使用 OpenGrove 的 Agent 能力，无需先做成 OP App，
也无需采用 OP 界面。本地 Host 负责 Agent 执行，接入方负责自己的界面和业务操作。
本契约面向单一本地所有者。

## 交付内容

| 接口 | 用途 |
| --- | --- |
| 本地 Host | 原生 Kernel 适配、任务执行、持久化、交互及可选模块 |
| Host Protocol | SDK 与 CLI 共用的类型化操作和 OpenAPI |
| `@opengrove/sdk` | 生成的底层操作，以及连接、持续会话、任务观察封装 |
| `opengrove` CLI | 启动 Host、查看接口结构、通过脚本调用相同能力 |

使用 Node.js 24 构建：

```sh
npm ci
npm run pack:local
```

产物为 `release/local/opengrove-host-0.7.0.tgz` 和
`release/local/opengrove-sdk-0.1.0.tgz`。在接入项目执行
`npm install /绝对路径/安装包.tgz` 即可安装。本地 Host 包包含服务代码、内置 Skills
及运行依赖，不含测试、Electron、桌面输出和 Web UI 输出。包导出
`startOpenGroveServer(options)`，返回 Node HTTP server；`server.close()` 关闭调度和
工作进程。它仍复用现有 Host 的模块组装及内部存储依赖，尚不是能够逐个独立安装的
Kernel、Room、Skill 包。这里不代表已经发布到 npm。

## 启动和连接

为接入产品设置独立数据目录和明确的 Bridge token。配置及原生登录发现遵循现有 Host
规则，见[配置说明](CONFIGURATION.md)和[安全模型](SECURITY_MODEL.md)。

```sh
export OPENGROVE_USER_DATA_DIR=/absolute/path/to/product-runtime
export OPENGROVE_WORKSPACE_ROOT=/absolute/path/to/product-project
export OPENGROVE_WEB_AUTH_MODE=bridge-token
export OPENGROVE_BRIDGE_TOKEN=your-local-secret
npx --no-install opengrove start --host 127.0.0.1 --port 37371
```

源码构建 `npm run build:server` 后，可用 `node dist/cli.js` 替代安装后的命令。
所选 Kernel 需要已安装并登录，或有配置好的 Provider。`$login` 表示原生登录路由。
浏览器还需要允许的 Origin。Token 授权整个单所有者 Host，不代表租户或单会话权限；
应保存在可信的本地集成或后端，不能直接嵌入公开网站、小程序包。

```js
import { connectOpenGrove } from '@opengrove/sdk';

const op = await connectOpenGrove({
  baseUrl: 'http://127.0.0.1:37371/api',
  token: process.env.OPENGROVE_BRIDGE_TOKEN,
});
const runtime = { kernel: 'codex', providerId: '$login', model: 'gpt-6-astra',
  workspaceRoot: '/absolute/path/to/project' };
const inspection = await op.api.host.runtime.inspect({ body: runtime });
if (!inspection.data.available) throw new Error(inspection.data.reason);
const session = op.session({ sessionId: 'my-project', ...runtime });
const task = await session.run('解释当前选区', { selection: '产品提供的文档片段' });
const result = await task.wait({ onEvent: event => console.log(event.type) });
console.log(result.run.lifecycle.taskState, result.answer);
```

通过 `op.api.host.runtime.list()` 查看当前模型选项，再检查明确的 Provider 路由。
发现可用不代表完成了一次真实调用；示例模型也不保证对所有账号可用。

## 会话、上下文和结果

Session 是持续会话，Run 是一次执行。首次直接执行把会话绑定到 Kernel、请求模型、
Provider 和工作区；绑定冲突或同会话已有执行时返回 409。切换绑定应使用新会话 ID。
可传入指令、文本或 JSON 上下文、文本/图片/文件附件、展示的 Skill 名称和访问模式。
上下文是每次执行传入的快照，不是产品状态的自动双向同步；原生历史可能保留旧输入。
附件支持取决于 Kernel 和模型，大媒体应使用项目文件和产品工具。
恢复会话时也应恢复原来的工具定义、指令及访问配置。原生会话还受 Kernel 自身的
绑定条件约束，例如 Codex 更换动态工具定义时会建立新的原生线程；相同 OP Session ID
不代表任何配置变化下都能保留原生上下文。

`task.wait()` 用游标消费事件并等待最终输出；失败和取消保留真实生命周期。
`task.result()` 读取快照，`outputAvailable` 和 `finalized` 区分已保存输出和未结束任务。
完整回答独立于有大小限制的事件摘要持久化。
`op.api.artifact.artifact` 支持产物创建、读取、列表、更新、删除。
`op.api.workspace.file` 列出、读取和写入会话绑定工作区内的文件；覆盖文件需提供读取
所得 revision，新建使用 `missing`，拒绝路径越界、逃逸符号链接和过期版本。

`task.cancel()` 取消执行；中止传给 `wait()` 的 signal 只停止观察。
`task.guide()` 和 `op.api.run.direct.compact()` 在 Kernel 支持时复用原生控制。
保留期内可回读事件；游标过期明确报历史不完整。已完成结果可在 Host 重启后读取，
丢失执行进程的任务由现有恢复机制标记为 lost，不承诺未完成执行自动续跑。

## 产品工具与人工交互

在会话传入 `tools`，每个工具包含 `client.*` ID、描述、JSON 输入结构和异步
`execute(input, {runId, callId, signal, deadlineAt})`。处理函数可以在前端、本地插件或后端执行，
由接入方验证业务输入与权限，返回 `{ok, value?, error?}`。工具可先在产品自己的界面
征求用户确认。见可运行的[外部编辑器示例](../../examples/external-editor/index.mjs)。

Host 把定义交给原生 Agent，接收真实工具调用，等待接入方回传结果，再交回同次执行。
底层接口为 `run.tool.list` 和 `run.tool.resolve`。默认等待 120 秒，可配置为 1–600 秒；
失去观察者不会默认为成功。取消或过期后回传会冲突，同一结果重复回传可接受，修改结果
则冲突。工具仅属于该任务，不注册到全局。同一个 SDK task 对象在重新观察时复用尚在
执行的函数和已完成结果；跨对象、进程或多个客户端，需要接入方按 `callId` 持久化幂等
凭据，不保证业务副作用恰好一次。Host 重启后不会重放未完成工具调用。

原生审批、追问通过 `wait({onApproval, onQuestion})` 或 `op.api.interaction` 处理，
列表可按 `runId` 筛选。是否支持某种原生交互、是否继续同次执行，由 Kernel 和模式
决定。产品工具的确认由产品掌握，不依赖特定 Kernel 的追问模式。
`planMode` 沿用 OP 现有的规划输入适配，不保证切换原生 Agent 的协作模式。当前
Codex 的 `request_user_input` 在原生 Default 模式不可用，不能仅凭 `planMode: true`
或能力发现中的 `elicitation` 字段推断该工具可调用。
工具与 Skill 选择不能替代原生沙箱策略：Kernel 可能保留自己的 shell/文件工具。
工作区是文件 API 的访问边界，不是通用操作系统沙箱；访问模式由具体 Kernel 执行。

## 可选模块

| 需求 | SDK 命名空间 | 依赖和语义 |
| --- | --- | --- |
| 角色 | `api.employee.employee` | 复用持久化 Employee 配置；单任务可直接使用指令 |
| 协作 | `api.room` | 复用成员、消息、委派和调度，保留 Room 的参与及授权规则 |
| Skills 和扩展 | `api.extension` | 发现、导入、发布、刷新、移除 Skills；启停及删除原生部署；明确项目或用户范围 |
| 流程 | `api.routine.routine` | 创建、导入、查询、运行、调度；员工步骤复用 Rooms，工具步骤要求 Host 已注册工具 |
| 历史与进度 | `api.run` | 会话、任务、执行记录、事件游标和任务控制 |

任务的客户端回调不是可持久调度的全局工具注册。定时流程使用已安装的 Host 工具，或
配置好能力的员工步骤。定时执行需要 Host 持续运行，不承诺分布式调度或错过时间后补跑。
扩展发布会影响原生配置，更改后应新建会话。知识、记忆、反馈的新接口抽象和服务器多租户
不在本次契约中，已有内部持久化依赖继续存在。

## CLI 和验证

无需连接即可查看准确参数：

```sh
opengrove schema run.direct.start
opengrove schema extension.skill.publish
opengrove schema routine.routine.create
opengrove host runtime list
```

使用 `OPENGROVE_BRIDGE_URL` 和 `OPENGROVE_BRIDGE_TOKEN` 连接运行中的 Host。
高风险 CLI 修改需要 `--yes`；SDK 使用显式方法。
`npm run test:local-integration` 验证契约、文件冲突、工具生命周期和 SDK 观察行为。
再运行 `npm run smoke:server`、`npm run smoke:critical` 验证回归。
测试夹具不代表原生 Kernel 能力，需用外部编辑器示例验证实际安装的 Kernel。

## Host 组合方式

桌面和外部产品使用同一条执行链路。可选模块在启动时选择，不在任务运行时切换：

```js
import { startOpenGroveServer } from '@opengrove/host';
const server = startOpenGroveServer({
  port: 37371,
  statePath: '/absolute/path/to/product-runtime/state.sqlite',
  bridgeToken: process.env.OPENGROVE_BRIDGE_TOKEN,
  modules: [], // 任务、Skills、工作区文件、结果和人工交互
});
```

| 选择 | 附加行为 |
| --- | --- |
| `[]` | 不初始化默认 Room/Employee，不恢复 App 激活，不注册挂载 App 工具，不启动 Routine 定时器 |
| `['rooms']` | 员工、房间、委派及既有授权规则 |
| `['rooms', 'routines']` | 工作流接口、工具和本地定时器 |
| `['rooms', 'apps']` | App 挂载、生命周期、App 工具和产品 UI 路由 |
| 省略 | 启用全部三个模块，保留桌面的默认组合 |

Apps 和 Routines 当前依赖 Rooms；非法组合在打开状态存储前报错。
CLI 读取 `OPENGROVE_HOST_MODULES=core`，或 `rooms,routines` 这样的逗号分隔列表。
程序显式传入的选项优先于环境变量。`host.runtime.list` 返回当前启用的 `modules`；
未启用模块的接口返回 404。停用模块不删除其持久化数据。产品应使用独立数据目录。

这是执行和组装边界，不是操作系统安全边界，也不意味着依赖包已经全部拆分。
共享持久化仍包含 Room 和知识存储接口；本次没有新抽象知识与反馈系统。
模块开关不会限制原生 Agent 自身的 shell 或文件权限。

## 重连和失败行为

| 情况 | 约定与接入方处理 |
| --- | --- |
| 页面关闭或停止观察 | Host 继续执行。用 `op.task(runId, tools)` 重新接入；有效期内可再次获取待处理工具、审批和问题 |
| 网络请求失败 | `wait()` 抛错。复用 task 对象再次 `wait()`，不要以新建 Run 代替重连 |
| 事件历史过期 | `wait()` 默认抛错。提供 `onHistoryGap(gap)` 明确接受不完整重放后继续；完整输出通过 `result()` 读取 |
| 产品工具超时或取消 | 到达截止时间，或观察到调用不再 pending 时，回调 signal 中止。提交业务副作用前检查 signal；迟到回传会冲突 |
| Host 退出或执行进程丢失 | 已完成结果仍保存。未完成执行不自动续跑；新建任务前先检查实际生命周期 |
| 原生会话续接 | Host 持久化执行实例产生的原生续接标识；能否续接仍取决于 Kernel 的原生会话支持及配置 |

回调收到 `{runId, callId, signal, deadlineAt}`。停止观察也会中止处理函数的 signal，
但不能撤销已经提交的业务操作；操作凭据应与业务修改一起持久化。
原生审批、问题与产品自己的确认界面是不同机制；原生交互的输入、期限和响应形式
依然随 Kernel 变化。

## 产品接入形态

聊天框是可选的。按钮、后台业务事件、CLI 或另一个 Agent 都可以发起同样的任务。
产品可以通过所选 Kernel 支持的配置，复用已有 CLI、MCP 服务和项目文件；需要在
前端或插件内部执行的动作，也可以提供回调。不是每个已有业务动作都要重新写成
`client.*` 函数。凭据和权限应在真正的业务服务边界校验；OP 不会自动推导产品接口，
也不会自动获得这些接口的访问权限。

[外部编辑器](../../examples/external-editor/README.zh-CN.md)提供独立网页（`npm run web`），
包含配置检查、产品操作确认、进度、取消和持久任务历史。它的本地伴随进程保管 Host
Token，检查真实待处理工具调用，将项目修改和操作凭据一起写入。
这个示例展示一种接入方式，不是通用 OP UI 组件包，也不是完整剪辑软件。

真实原生验收先构建 SDK，再从仓库运行：

```sh
npm run test:local-integration:real -- --kernel codex --model YOUR_MODEL \
  --provider '$login' --workspace /absolute/path/to/isolated-project
```

设置 `OPENGROVE_BRIDGE_TOKEN`，按需传 `--base-url`。探针记录观察到的 Kernel 版本，
分别检查产品工具执行、连续会话和取消；会发起真实模型请求，安装或发现成功不能
代替探针通过。原生审批、结构化追问、Skills 和压缩仍需分别验收，不能据此宣称
所有 Kernel 能力一致。
