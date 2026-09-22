import { DEFAULT_HOST_MODULES } from "../../app/host-modules.js";
import type { listRuntimesOperation, inspectRuntimeOperation } from "#protocol";
import { hostContractById } from "#protocol/compiled";
import type { BridgeRoute, HostOperationRouteContext } from "../router.js";
import { getBridgeKernelOptions, getBridgeRuntimeControlsByKernel } from "../kernel-selection.js";
import { normalizeWorkspaceRootValue, resolveBridgeWorkspaceRoot } from "../workspace-root.js";
import { resolveAskExecutionState } from "../ask-execution-state.js";
import { operationRoute } from "./registry-utils.js";

export function createRuntimeRoutes(): BridgeRoute[] {
  return [
    operationRoute(hostContractById["host.runtime.list"], list),
    operationRoute(hostContractById["host.runtime.inspect"], inspect),
  ];
}
function list(context: HostOperationRouteContext<typeof listRuntimesOperation>): true {
  context.sendJson(context.response, 200, {
    ok: true,
    modules: context.state.modules ?? DEFAULT_HOST_MODULES,
    kernels: getBridgeKernelOptions(context.state),
    controls: getBridgeRuntimeControlsByKernel(context.state),
  });
  return true;
}
function inspect(context: HostOperationRouteContext<typeof inspectRuntimeOperation>): true {
  const input = context.input.body;
  const workspaceRoot = input.workspaceRoot ? normalizeWorkspaceRootValue(input.workspaceRoot) : undefined;
  if (input.workspaceRoot && !workspaceRoot) {
    context.sendJson(context.response, 400, { ok: false, error: "workspace_directory_not_found" });
    return true;
  }
  const state = resolveAskExecutionState(context.state, { ...input, workspaceRoot });
  context.sendJson(context.response, 200, {
    ok: true,
    available: !state.kernelUnavailableReason,
    reason: state.kernelUnavailableReason,
    kernel: state.kernel,
    model: state.kernelRuntimeModel ?? input.model,
    providerId: state.kernelProviderId,
    workspaceRoot: resolveBridgeWorkspaceRoot(state.settings),
    capabilities: state.kernelAdapter?.capabilities,
  });
  return true;
}
