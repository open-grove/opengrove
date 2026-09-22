import { connectOpenGrove } from "/sdk/index.js";
const el = (id) => document.getElementById(id);
const terminal = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"]);
let op, project, discovery, activeTask, observer, observation, configuration;
const tasks = new Map();
const status = (text, error = false) => {
  el("status").textContent = text;
  el("status").className = error ? "error" : "";
};
const message = (text, kind = "") => {
  const item = document.createElement("div");
  item.className = `message ${kind}`;
  item.textContent = text;
  el("messages").append(item);
  item.scrollIntoView({ block: "nearest" });
};
async function product(path, value) {
  const response = await fetch(`/product/${path}`, {
    headers: { "x-editor-client": "1", "content-type": "application/json" },
    ...(value ? { method: "POST", body: JSON.stringify(value) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
function errorText(error) {
  return error?.message ?? error?.error ?? JSON.stringify(error);
}
function renderProject() {
  el("title").textContent = project.title;
  el("workspace").textContent = project.workspace;
  el("clips").replaceChildren(
    ...project.clips.map((title) => {
      const clip = document.createElement("div");
      clip.className = "clip";
      clip.textContent = title;
      return clip;
    }),
  );
}
function promptUser(title, detail, signal, { question = false, deadlineAt } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const card = document.createElement("div");
    card.className = "interaction";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const description = document.createElement("p");
    description.textContent = detail;
    card.append(heading, description);
    const input = document.createElement("textarea");
    if (question) {
      input.placeholder = "输入回答";
      card.append(input);
    }
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      card.remove();
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("请求已结束"));
    };
    for (const [label, accepted] of [
      [question ? "提交回答" : "允许", true],
      ["拒绝", false],
    ]) {
      const button = document.createElement("button");
      button.textContent = label;
      button.onclick = () => {
        if (question && accepted && !input.value.trim()) return;
        cleanup();
        resolve(question ? { accepted, text: input.value } : accepted);
      };
      card.append(button);
    }
    if (deadlineAt)
      timer = setTimeout(
        () => {
          cleanup();
          reject(new Error("请求已过期"));
        },
        Math.max(0, Date.parse(deadlineAt) - Date.now()),
      );
    signal?.addEventListener("abort", abort, { once: true });
    el("interactions").append(card);
  });
}
const tools = [
  {
    id: "client.renameTimeline",
    description: "Rename the current timeline after the product asks its user to approve.",
    timeoutMs: 120000,
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", minLength: 1, maxLength: 120 } },
      required: ["title"],
      additionalProperties: false,
    },
    async execute(input, { runId, callId, signal, deadlineAt }) {
      if (typeof input.title !== "string") return { ok: false, error: "title_required" };
      const approved = await promptUser("确认修改项目", `将“${project.title}”改名为“${input.title}”？`, signal, {
        deadlineAt,
      });
      if (!approved) return { ok: false, error: "user_rejected" };
      signal.throwIfAborted();
      const result = await product("rename", { runId, callId, title: input.title });
      project = await product("project");
      renderProject();
      return result;
    },
  },
];
async function history() {
  const { data } = await op.api.run.run.list({ query: { sessionId: project.sessionId, limit: 100 } });
  if (!data.runs) return;
  el("history").replaceChildren();
  for (const run of [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const button = document.createElement("button");
    button.className = "history-item";
    button.textContent = run.input || run.id;
    const detail = document.createElement("small");
    detail.textContent = `${run.lifecycle.taskState} · ${run.createdAt}`;
    button.append(detail);
    button.onclick = () => void openRun(run.id).catch((error) => status(errorText(error), true));
    el("history").append(button);
  }
  return data.runs;
}
async function stopObserving() {
  observer?.abort(new Error("已断开观察，任务仍在 Host 中运行"));
  await observation;
}
async function openRun(id) {
  await stopObserving();
  activeTask = tasks.get(id) ?? op.task(id, tools);
  tasks.set(id, activeTask);
  const result = await activeTask.result();
  if (result.finalized) {
    el("cancel").disabled = true;
    el("observe").disabled = true;
    message(result.answer || "任务没有生成文本结果。");
    status(result.run.lifecycle.taskState);
    return;
  }
  startObserving();
}
function startObserving() {
  const task = activeTask;
  const control = new AbortController();
  observer = control;
  el("observe").disabled = false;
  el("observe").textContent = "断开观察";
  el("cancel").disabled = false;
  el("send").disabled = true;
  status("Agent 正在处理…");
  observation = task
    .wait({
      signal: control.signal,
      onHistoryGap() {
        message("部分早期进度已过期；最终结果仍从 Host 的完整记录读取。");
      },
      onEvent(event) {
        el("events").textContent = `${el("events").textContent}\n${event.type}`.slice(-10000);
      },
      async onApproval(approval) {
        const accepted = await promptUser(approval.title, approval.reason, control.signal, {
          deadlineAt: approval.deadlineAt,
        });
        return { decision: accepted ? "approve" : "reject" };
      },
      async onQuestion(question) {
        const input = question.input ?? {};
        const containers = [input, input.params, input.input, input.params?.input].filter(Boolean);
        const fields = containers.find((value) => Array.isArray(value.questions))?.questions;
        if (fields?.length) {
          const answers = {};
          for (const item of fields) {
            const choices = (item.options ?? [])
              .map((option) => (typeof option === "string" ? option : option.label))
              .join(" / ");
            const value = await promptUser(
              item.header || question.title,
              `${item.question || question.prompt}${choices ? `\n可选：${choices}` : ""}`,
              control.signal,
              { question: true, deadlineAt: question.deadlineAt },
            );
            if (!value.accepted) {
              await op.api.interaction.question.decline({ path: { questionId: question.id }, body: {} });
              throw new Error("已拒绝回答；请重新连接观察后续结果");
            }
            const key = item.id || item.question || item.header;
            answers[key] = input.toolName === "AskUserQuestion" ? value.text : { answers: [value.text] };
          }
          return { answers };
        }
        const answer = await promptUser(question.title, question.prompt, control.signal, {
          question: true,
          deadlineAt: question.deadlineAt,
        });
        if (!answer.accepted) {
          await op.api.interaction.question.decline({ path: { questionId: question.id }, body: {} });
          throw new Error("已拒绝回答；请重新连接观察后续结果");
        }
        return answer.text;
      },
    })
    .then(async (result) => {
      message(result.answer || "任务没有生成文本结果。");
      status(result.run.lifecycle.taskState);
      el("cancel").disabled = true;
      el("observe").disabled = true;
      project = await product("project");
      renderProject();
    })
    .catch((error) => status(errorText(error), true))
    .finally(async () => {
      if (observer === control) {
        observer = undefined;
        el("observe").textContent = "重新连接";
        el("send").disabled = false;
      }
      await history().catch((error) => status(errorText(error), true));
    });
}
function runtimeConfig() {
  return {
    kernel: el("kernel").value,
    model: el("model").value.trim(),
    providerId: el("provider").value.trim(),
    workspaceRoot: project.workspace,
  };
}
async function inspect() {
  const { data } = await op.api.host.runtime.inspect({ body: runtimeConfig() });
  el("runtime").textContent = data.available ? "配置可用。实际执行仍取决于 Agent 登录和模型服务。" : data.reason;
  if (!data.available) throw new Error(data.reason || "Agent 不可用");
  return data;
}
el("configuration").onsubmit = (event) => {
  event.preventDefault();
  void inspect().catch((error) => status(errorText(error), true));
};
el("kernel").onchange = () => {
  const controls = discovery.controls[el("kernel").value];
  el("models").replaceChildren(
    ...(controls?.models ?? []).map((model) => {
      const item = document.createElement("option");
      item.value = model.id;
      return item;
    }),
  );
  el("model").value = controls?.defaultModel || controls?.models?.[0]?.id || "";
};
el("composer").onsubmit = async (event) => {
  event.preventDefault();
  el("send").disabled = true;
  try {
    await inspect();
    const config = runtimeConfig();
    if (configuration && JSON.stringify(config) !== JSON.stringify(configuration))
      throw new Error("同一项目会话的 Agent、模型和路由不能中途更换。请恢复原配置，或使用新项目目录。");
    const input = el("prompt").value.trim();
    const session = op.session({
      ...config,
      sessionId: project.sessionId,
      tools,
      instructions:
        "Use client.renameTimeline for all timeline changes. Never edit timeline.json with shell or file tools. The product owns approval and data persistence.",
    });
    activeTask = await session.run(input, { title: project.title, clips: project.clips });
    configuration = config;
    tasks.set(activeTask.runId, activeTask);
    message(input, "user");
    el("prompt").value = "";
    startObserving();
    await history();
  } catch (error) {
    status(errorText(error), true);
    el("send").disabled = false;
  }
};
el("observe").onclick = () => {
  if (observer) void stopObserving();
  else if (activeTask) void openRun(activeTask.runId).catch((error) => status(errorText(error), true));
};
el("cancel").onclick = async () => {
  try {
    await activeTask.cancel();
    status("已请求取消，等待 Agent 确认。");
    if (!observer) startObserving();
  } catch (error) {
    status(errorText(error), true);
  }
};
try {
  project = await product("project");
  renderProject();
  op = await connectOpenGrove({ baseUrl: `${location.origin}/api`, headers: { "x-editor-client": "1" } });
  discovery = (await op.api.host.runtime.list()).data;
  for (const kernel of discovery.kernels) {
    const option = document.createElement("option");
    option.value = kernel.id;
    option.textContent = `${kernel.label}${kernel.installed === false ? "（未安装）" : ""}`;
    el("kernel").append(option);
  }
  if (discovery.kernels.some((kernel) => kernel.id === "codex")) el("kernel").value = "codex";
  el("kernel").onchange();
  const sessions = (await op.api.run.session.list({ query: { activity: "api", limit: 500 } })).data.sessions;
  const binding = sessions.find((session) => session.id === project.sessionId)?.metadata?.integrationSession;
  if (binding) {
    configuration = {
      kernel: binding.kernel,
      model: binding.model,
      providerId: binding.providerId,
      workspaceRoot: binding.workspaceRoot,
    };
    el("kernel").value = binding.kernel;
    el("kernel").onchange();
    el("model").value = binding.model;
    el("provider").value = binding.providerId;
  }
  const runs = await history();
  el("connection").textContent = "已连接本地 OP";
  const running = runs?.find((run) => !terminal.has(run.lifecycle.taskState));
  if (running) await openRun(running.id);
} catch (error) {
  el("connection").textContent = "连接失败";
  status(errorText(error), true);
}
