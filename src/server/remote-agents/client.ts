import { execFile } from "node:child_process";
import { z } from "zod";

const agentSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  address: z.string().min(1),
  name: z.string().min(1),
});
const partSchema = z.object({ text: z.string().optional() }).passthrough();
const messageSchema = z.object({ parts: z.array(partSchema).default([]), role: z.string().optional() }).passthrough();
export const remoteTaskSchema = z
  .object({
    id: z.string().min(1),
    contextId: z.string().min(1),
    status: z.object({
      state: z.enum([
        "TASK_STATE_SUBMITTED",
        "TASK_STATE_WORKING",
        "TASK_STATE_INPUT_REQUIRED",
        "TASK_STATE_AUTH_REQUIRED",
        "TASK_STATE_COMPLETED",
        "TASK_STATE_FAILED",
        "TASK_STATE_CANCELED",
        "TASK_STATE_REJECTED",
      ]),
      message: messageSchema.optional(),
    }),
    artifacts: z.array(z.object({ parts: z.array(partSchema) }).passthrough()).default([]),
    history: z.array(messageSchema).default([]),
  })
  .passthrough();
export type RemoteTask = z.infer<typeof remoteTaskSchema>;
export type RouterInvoker = (args: readonly string[], input?: string, signal?: AbortSignal) => Promise<unknown>;

async function invokeRouter(args: readonly string[], input?: string, signal?: AbortSignal): Promise<unknown> {
  const command = process.env.OPENGROVE_AGENT_ROUTER_BIN?.trim() || "agent-router";
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { timeout: 45_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout) => {
        // CLI diagnostics may contain operator paths. Only expose stable errors to Rooms.
        if (error) {
          reject(new Error(error.code === "ENOENT" ? "remote_cli_not_installed" : "remote_connection_unavailable"));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("remote_response_invalid"));
        }
      },
    );
    child.stdin?.on("error", () => reject(new Error("remote_connection_unavailable")));
    child.stdin?.end(input);
  });
}

export class AgentRouterClient {
  constructor(
    readonly profile: string,
    private readonly invoke: RouterInvoker = invokeRouter,
    private readonly signal?: AbortSignal,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error("remote_profile_invalid");
  }
  async current() {
    return z.object({ agent: agentSchema }).parse(await this.call(["agent-current"])).agent;
  }
  async verifySender(expected: string) {
    const selected = await this.current();
    if (selected.id !== expected) throw new Error("remote_sender_changed");
    return selected;
  }
  async connect() {
    const selected = await this.current();
    z.object({ status: z.literal("ready") }).parse(await this.call(["connect"]));
    return selected;
  }
  async resolve(address: string) {
    if (!/^[^\s/@]+\/[a-z][a-z0-9-]{0,47}@[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(address))
      throw new Error("remote_address_invalid");
    return z
      .object({ address: z.string().min(1), matrixId: z.string().min(1) })
      .parse(await this.call(["agent-resolve", address]));
  }
  async send(address: string, text: string, contextId: string | undefined, messageId: string, inputTaskId?: string) {
    // stdin keeps messages out of process arguments and treats literal "-" / "--help" as text.
    return remoteTaskSchema.parse(
      await this.call(
        [
          "send",
          ...(contextId ? ["--context-id", contextId] : []),
          "--message-id",
          messageId,
          ...(inputTaskId ? ["--task-id", inputTaskId] : []),
          "--",
          address,
          "-",
        ],
        text,
      ),
    );
  }
  async get(address: string, taskId: string) {
    return remoteTaskSchema.parse(await this.call(["get", address, taskId]));
  }
  async cancel(address: string, taskId: string) {
    await this.call(["cancel", address, taskId]);
  }
  private call(args: readonly string[], input?: string) {
    return this.invoke(["--profile", this.profile, ...args], input, this.signal);
  }
}

export function remoteTaskText(task: RemoteTask): string {
  const artifact = task.artifacts
    .flatMap((item) => item.parts)
    .flatMap((part) => (part.text ? [part.text] : []))
    .join("\n\n");
  if (artifact) return artifact;
  const message = task.status.message ?? [...task.history].reverse().find((item) => item.role === "ROLE_AGENT");
  return message?.parts.flatMap((part) => (part.text ? [part.text] : [])).join("\n\n") ?? "";
}
