import type { CompiledHostOperation } from "#protocol/compiler";

/** Public CLI presentation keeps canonical Protocol IDs available for tooling. */
export function operationCommandPath(operation: CompiledHostOperation): string[] {
  return operation.groupId === operation.resourceId
    ? [operation.groupId, ...operation.methodName.split(".")]
    : operation.id.split(".");
}

export function operationCommandPaths(operation: CompiledHostOperation): string[][] {
  const canonical = operation.id.split(".");
  return operation.groupId === operation.resourceId ? [canonical, operationCommandPath(operation)] : [canonical];
}

export function matchOperationCommand(args: readonly string[], operations: readonly CompiledHostOperation[]) {
  return operations
    .flatMap((operation) => operationCommandPaths(operation).map((path) => ({ operation, path })))
    .sort((left, right) => right.path.length - left.path.length)
    .find(({ path }) => path.every((segment, index) => args[index] === segment));
}
