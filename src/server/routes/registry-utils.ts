import { decodeHostOperationInput, type BridgeRoute, type HostOperationRouteContext } from "../router.js";
import type { BridgeJsonContract, HostOperation } from "#protocol";
import type { CompiledHostOperation } from "#protocol/compiler";

export function route(
  id: string,
  method: string | string[],
  path: BridgeRoute["path"],
  handle: BridgeRoute["handle"],
  contract?: BridgeJsonContract | HostOperation,
): BridgeRoute {
  return { id, method, path, handle, ...(contract ? { contract } : {}) };
}

export function moduleRoute(id: string, path: BridgeRoute["path"], handle: BridgeRoute["handle"]): BridgeRoute {
  return { id, path, handle };
}

export function operationRoute<TOperation extends HostOperation>(
  operation: CompiledHostOperation<TOperation>,
  handle: (context: HostOperationRouteContext<TOperation>) => void | true | Promise<void | true>,
): BridgeRoute {
  return route(
    operation.id,
    operation.method,
    new RegExp(operation.path.regexpSource, "u"),
    async (context) => {
      await handle(await decodeHostOperationInput(operation, context));
      return true;
    },
    operation.operation,
  );
}
