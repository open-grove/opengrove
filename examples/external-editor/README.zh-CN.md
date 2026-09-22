# 外部编辑器示例

[English](README.md)

这是一个使用真实 Agent 和公共 SDK 的普通 Node.js 产品。它创建自己的
`project/timeline.json`，向 Agent 提供改名工具，并在修改前询问用户；无需 OP App。

1. 在仓库根目录执行 `npm run pack:local`。
2. 按[本地接入指南](../../docs/reference/LOCAL_INTEGRATION.zh-CN.md)安装并启动 Host。
3. 在本目录执行 `npm install`，配置 `OPENGROVE_BRIDGE_URL`、
   `OPENGROVE_BRIDGE_TOKEN` 和可用的 `AGENT_MODEL`。
4. 执行 `npm start`，要求修改时间线标题，确认或拒绝后，在同一会话继续追问。

`EDITOR_WORKSPACE` 指定绝对项目目录。`EDITOR_SESSION_ID` 在绑定匹配时复用已有会话。
默认使用 Codex 原生登录，`AGENT_PROVIDER` 可指定已配置的 Provider。Token 授权本地
所有者，应保密。

示例的 JSON 凭据可避免普通重连时重复执行最后一次调用。生产接入应使用原子操作凭据，
并执行自己的业务权限校验。原生审批和追问使用简单文字提示，并非所有 Kernel 结构化
问题的完整渲染器。

## 独立网页

完成上述安装并启动 Host 后，在本目录运行 `npm run web`，打开输出的本地地址
（默认 `http://127.0.0.1:37430`）。可用 `EDITOR_PORT` 调整端口，
`EDITOR_WORKSPACE` 选择绝对项目目录，`OPENGROVE_BRIDGE_URL` 指向 Host。
网页可选择已配置的 Kernel、模型和 Provider；同一项目会话保持其原有绑定。

试着发起改名，在确认面板出现时刷新页面，再确认：同一任务会重新出现，
产品改名后可继续对话。任务历史和项目状态在重新打开页面后保留。
“断开观察”不取消 Host 任务，“取消任务”才会发送取消请求。
原生结构化提问支持常见问题列表和文字回答，并非通用表单渲染器。

Token 只保留在本地伴随进程。网页用同源请求访问该进程，伴随进程仅代理示例
所需的 Host 操作。改名回执与项目一起原子写入，并校验调用属于当前项目、
尚未过期且仍待处理；多个标签页重试相同调用不会重复应用修改。
它仍是本机单主体示例，不能原样部署为多用户网站。

`npm start` 是原来的命令行版本；`npm run web` 是独立网页版本。
