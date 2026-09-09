import { readAppEnv } from "../../identity.js";
import { resumeRemoteRoomRuns } from "../room-runs.js";
import { createHash } from "node:crypto";
import type {
  AddNetworkContactOperation,
  InspectNetworkAccountOperation,
  ConnectNetworkAccountOperation,
} from "#protocol";
import { requireNetworkConnection, networkProblem } from "../remote-agents/session.js";
import type { HostOperationRouteContext } from "../router.js";

export async function handleInspectNetworkAccount(
  context: HostOperationRouteContext<InspectNetworkAccountOperation>,
): Promise<true> {
  context.sendJson(context.response, 200, { ok: true, configured: Boolean(readAppEnv("AGENT_ROUTER_URL")?.trim()) });
  return true;
}

export async function handleConnectNetworkAccount(
  context: HostOperationRouteContext<ConnectNetworkAccountOperation>,
): Promise<true> {
  try {
    const { sender: account } = await requireNetworkConnection(context);
    await resumeRemoteRoomRuns(context.state);
    context.sendJson(context.response, 200, { ok: true, account });
  } catch (error) {
    const problem = networkProblem(error);
    context.sendJson(context.response, problem.status, { error: problem.error });
  }
  return true;
}

export async function handleAddNetworkContact(
  context: HostOperationRouteContext<AddNetworkContactOperation>,
): Promise<true> {
  const { address, name } = context.input.body;
  try {
    const connection = await requireNetworkConnection(context);
    const remote = await connection.request(({ client, signal }) => client.resolve(address, { signal }));
    const id =
      "remote-" +
      createHash("sha256")
        .update(JSON.stringify([connection.binding, remote.address, remote.matrixId]))
        .digest("hex")
        .slice(0, 24);
    const existing = context.state.app.rooms.listMembers().find((member) => member.id === id);
    if (!existing || existing.disabled) {
      context.state.app.rooms.upsertMember(
        {
          id,
          name: name || address.split("/")[1]!.split("@")[0]!,
          source: "remote",
          kernel: "remote",
          model: "remote",
          role: "",
          status: "idle",
          color: "#3b82f6",
          lastActive: new Date().toISOString(),
          remoteAgent: {
            ...connection.binding,
            address: remote.address,
            matrixId: remote.matrixId,
          },
          publicDescription: remote.address,
        },
        { emitEvent: true },
      );
      context.state.store.saveFrom(context.state.app);
    }
    context.sendJson(context.response, 200, { ok: true, memberId: id });
  } catch (error) {
    const problem = networkProblem(error);
    context.sendJson(context.response, problem.status, { error: problem.error });
  }
  return true;
}
