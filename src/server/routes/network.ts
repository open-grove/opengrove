import { createHash } from "node:crypto";
import type { AddNetworkContactOperation, InspectNetworkAccountOperation } from "#protocol";
import { AgentRouterClient } from "../remote-agents/client.js";
import type { HostOperationRouteContext } from "../router.js";

const networkErrors = new Set([
  "remote_cli_not_installed",
  "remote_connection_unavailable",
  "remote_response_invalid",
  "remote_profile_invalid",
  "remote_address_invalid",
  "remote_sender_changed",
]);
function networkError(error: unknown) {
  return error instanceof Error && networkErrors.has(error.message) ? error.message : "remote_response_invalid";
}

export async function handleInspectNetworkAccount(
  context: HostOperationRouteContext<InspectNetworkAccountOperation>,
): Promise<true> {
  try {
    const account = await new AgentRouterClient(context.input.body.profile).connect();
    context.sendJson(context.response, 200, { ok: true, account });
  } catch (error) {
    context.sendJson(context.response, 503, { error: networkError(error) });
  }
  return true;
}

export async function handleAddNetworkContact(
  context: HostOperationRouteContext<AddNetworkContactOperation>,
): Promise<true> {
  const { profile, address, name } = context.input.body;
  try {
    const client = new AgentRouterClient(profile);
    const sender = await client.connect();
    const remote = await client.resolve(address);
    const id =
      "remote-" +
      createHash("sha256")
        .update(JSON.stringify([sender.id, remote.address]))
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
            profile,
            senderAgentId: sender.id,
            owner: sender.owner,
            address: remote.address,
          },
          publicDescription: remote.address,
        },
        { emitEvent: true },
      );
      context.state.store.saveFrom(context.state.app);
    }
    context.sendJson(context.response, 200, { ok: true, memberId: id });
  } catch (error) {
    context.sendJson(context.response, 503, { error: networkError(error) });
  }
  return true;
}
