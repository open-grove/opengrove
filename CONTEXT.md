# CONTEXT.md — 共享语言

OpenGrove 的领域词汇表。只放术语定义，不放实现细节。代码、文档、issue 的命名一律用这里的规范词；术语歧义解决后当场更新本文件。

## 运行层

**Kernel（内核）** — 外部原生编码 agent 本体（Codex、Claude Agent、Hermes 等），自带模型循环、工具、会话与鉴权。OpenGrove 不替代它，只在外围做产品层。
_避免_：engine（那是 Kernel 的可执行二进制）、runtime、agent（太泛）

**Engine（引擎）** — 某个 Kernel 的可执行二进制（如桌面版内置的 Claude 引擎）。Kernel 是概念角色，Engine 是装在机器上的那个文件。

**Host（宿主）** — OpenGrove 自身的产品层：本地状态、bridge API、房间、知识库、审批、设置与诊断。

**Adapter（适配器）** — 把某个 Kernel 的原生传输 / 事件 / 工具映射为 OpenGrove 事件与控制的桥接层。一个 Kernel 对应一个 Adapter。

**Bridge（本地桥）** — 只在本机监听的 HTTP 服务：承载 UI、持久化宿主状态、把轮次路由给选中的 Kernel。
_避免_：server（太泛）

**WW（OpenGrove Cloud API）** — OpenGrove 托管后端服务的内部代号，即公开文档中的 OpenGrove Cloud API。

**Provider（模型提供方）** — 向 Kernel 提供模型服务的具体路由，例如 OpenAI Official、AWS Bedrock、DeepSeek、WW，或 OpenClaw Gateway 中配置的上游服务。凭据可由 Host、Kernel 或 Gateway 保管；这是 Provider 的接入/管理方式，不改变其 Provider 路由身份。

**Login（账号登录）** — Kernel 产品账号自身的登录路线，例如 ChatGPT/Codex、Claude Agent 或 Kimi Code 登录。Login 不是 Provider；只有账号产品本身的登录态才属于 Login，Kernel 扫描到的 AWS、Vertex、API Key 或其他模型服务仍属于 Provider。

**Gateway（网关）** — Provider 的一种接入/管理方式，负责连接、发现、凭据保管和会话控制，例如 OpenClaw Gateway。Gateway 可管理多个 Provider；路由选择仍然是具体 Provider，Gateway 不是第三种路由身份。

**Provider Route（供应商路由）** — 某个 Employee Run 最终使用哪个 Provider 或 Login 的用户本机选择。优先级是 Employee 显式覆盖、用户模型默认；都没有时要求选择。WW 可在本机首次获得可用凭据时一次性初始化产品模型默认，但运行时不推导、后续不覆写用户改动。Login 是显式选项，不是兜底。

**Provider Binding（供应商绑定）** — 旧的 Kernel 级 Provider 设置，只在设置读取边界一次性迁移为模型默认，不进入 Web 或运行时。

**Turn（轮次）** — 一次"用户输入 → agent 完成回应"的往返，Bridge 把它路由给选中的 Kernel。

**Run（运行）** — 一次由消息触发的 Kernel 执行过程，状态记在房间账本里。

**Approval（审批）** — 风险动作的放行请求：先挂起，经 UI 批准后才继续。

## 产品对象

**App（OpenGrove App）** — 可挂载的便携工作台包：清单（`opengrove.app.json`）+ 工作区文件，可捆绑 Skill、CLI、Employee。
_避免_：插件、plugin

**App Workspace（App 工作区）** — App 挂载后归它的持久化工作区目录，其 Employee 的读写边界由清单声明；它不随正式 App 版本切换而迁移。

**Workbench（工作台）** — 一个 App 呈现给用户的界面形态（如 file-workbench）。App 是包，Workbench 是它的界面。

**Employee（员工）** — App 声明的房间 agent 角色，绑定到该 App 及其工作区，指令来自 App 内的 `AGENTS.md`。
_避免_：persona、内置角色、builtin agent

**Skill（技能）** — 一段可复用的 agent 指令文件，带来源（bundled / project / user / pack）与信任级（trusted / untrusted）。Employee 声明的默认 Skill 是每轮行动前必须加载的工作方法：支持原生 Skill 的 Kernel 按 Host 提供的名称与入口加载，其他 Kernel 由 Host 注入正文兼容；非默认 Skill 仍按需加载，保留渐进披露。

**Pack（技能包）** — 一组 Skill 的分发单位，整包声明来源与信任级。

**Routine（例程）** — 把用户目标固化成的可重复工作流文件（`.routine.md`），由 App 的员工与宿主工具编排执行。

**App Store（应用商店）** — App 包的目录与安装入口；Host 从配置的 Registry 获取、校验并安装到本机 App 目录。

**App Release Control（App 发布控制服务）** — 独立承载 App Registry、正式版本目录、发布事务、GitHub 供应链编排和制品登记的第一方服务。它复用 WW 的账号身份事实；v1 不属于 WW 进程或部署，但在同一环境复用 WW 数据库连接并只拥有 `app_release_*` 表。
_避免_：WW App Release 模块、GitHub 仓库、App Store 页面

**Formal App Version（正式版本）** — 一个已经发布到 App Store、由 App 身份、版本号和内容摘要共同确定且不可覆盖的 App 快照。
_避免_：草稿版本、个人版本、branch

**Selected App Version（选中版本）** — 一台设备为一个已安装 App 明确选择的正式版本。它属于该设备，不是组织共享设置；预览本机草稿时也不把草稿误称为选中版本。
_避免_：当前云端版本、组织版本、latest 指针

**Local App Draft（本机草稿）** — 一次 OpenGrove 本机安装为一个 App 保存的唯一未发布候选内容，包含可编辑 App 内容和拟发布的员工配置，只留在该安装中且没有正式版本号；它不属于 WW 账号。
_避免_：本地版本、发布草稿、个人云版本

**Publish Base（发布基础）** — 本机草稿开始修改时所依据的正式版本。它用于判断草稿能否继续发布，不因查看或切换其他正式版本而静默改变。
_避免_：merge base、当前分支、选中版本

**App Version Switch（版本切换）** — 把一台设备的选中版本换成另一个兼容正式版本，同时保留该 App 的工作区、聊天和其他业务状态。版本切换不是业务数据回滚。
_避免_：数据回滚、workspace 回滚、组织回滚

**Grove** — 内置的向导 Employee 及其同名产品房间，负责新手引导与排障。

## 协作对象

**Room（房间）** — Host 记账的本地聊天空间：成员、消息、@提及与运行状态。Room ID 只是存储身份；属于某个 App 时由 Host 单独保存精确 App scope，不从 ID 或标题反推。

**Ledger（账本）** — 房间事件与消息在 Host 中的本地持久化。

**Knowledge Vault（知识库）** — 文件优先的本地知识存储，附带反馈 / 证据 / 修订 / 投递四类账本。

**Principal（主体）** — 一个所有权边界：某个用户及其设备与 agent。当前产品只处理本地主体，不包含跨主体协作。

## 治理

**Capability Contract（能力契约）** — 声明某 Kernel / Adapter 支持哪些能力的清单，字段规则见 `AGENTS.md`「测试纪律·诚实账本」。

## 关系

- 一个 **Kernel** 通过一个 **Adapter** 接入 **Host**；**Bridge** 是 Host 的进程载体，负责路由 **Turn**。
- 一个 **Employee** 选择 **Kernel** 与模型，并可覆盖 **Provider Route**；否则使用用户为该模型显式保存的 Provider 默认，未配置时不启动 Run。
- 一个 **App** 捆绑若干 **Employee** 与 **Skill**，呈现为一个 **Workbench**，读写限于自己的 **App Workspace**。
- 一个 **Room** 的历史记在 **Ledger** 里。
