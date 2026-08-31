import type { BridgeRoute } from "../router.js";
import type { BridgeJsonContract } from "#agent-protocol";

export function route(
  id: string,
  method: string | string[],
  path: BridgeRoute["path"],
  handle: BridgeRoute["handle"],
  contract?: BridgeJsonContract,
): BridgeRoute {
  return { id, method, path, handle, ...(contract ? { contract } : {}) };
}

export function moduleRoute(id: string, path: BridgeRoute["path"], handle: BridgeRoute["handle"]): BridgeRoute {
  return { id, path, handle };
}
