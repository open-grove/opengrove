import type { BridgeRoute } from "../router.js";
import type { BridgeJsonContract, HostOperation } from "#protocol";

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

export function operationRoute(operation: HostOperation, handle: BridgeRoute["handle"]): BridgeRoute {
  return route(operation.id, operation.method, operationPathPattern(operation.path), handle, operation);
}

function operationPathPattern(path: string): RegExp {
  const expression = path
    .split(/(\{[^/{}]+\})/u)
    .map((part) => (/^\{[^/{}]+\}$/u.test(part) ? "[^/]+" : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${expression}$`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
