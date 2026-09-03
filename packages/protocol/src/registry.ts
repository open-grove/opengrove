import type { HostOperation, HostOperationGroup } from "./operation.js";
import { authOperationGroup } from "./auth.js";
import { roomOperationGroup } from "./rooms.js";

export const hostOperationGroups = [
  authOperationGroup,
  roomOperationGroup,
] as const satisfies readonly HostOperationGroup[];

type OperationFromGroups<TGroups extends readonly HostOperationGroup[]> =
  TGroups[number]["resources"][number]["operations"][number];
type OperationById<TOperation extends HostOperation> = {
  readonly [TId in TOperation["id"]]: Extract<TOperation, { id: TId }>;
};

export type RegisteredHostOperation = OperationFromGroups<typeof hostOperationGroups>;
export type HostOperationId = RegisteredHostOperation["id"];

export const hostOperations = collectHostOperations(
  hostOperationGroups,
) as unknown as readonly RegisteredHostOperation[];

export const hostOperationById = indexHostOperations(hostOperationGroups);

export function findHostOperation(id: string): RegisteredHostOperation | undefined {
  return hostOperationById[id as HostOperationId];
}

function indexHostOperations<const TGroups extends readonly HostOperationGroup[]>(
  groups: TGroups,
): OperationById<OperationFromGroups<TGroups>> {
  const operations = new Map<string, HostOperation>();
  for (const group of groups) {
    for (const resource of group.resources) {
      const operationPrefix = `${group.id}.${resource.id}.`;
      for (const operation of resource.operations) {
        if (!operation.id.startsWith(operationPrefix) || operation.id.length === operationPrefix.length) {
          throw new Error(
            `Host operation ${operation.id} must start with ${operationPrefix} and include a method name.`,
          );
        }
        if (operations.has(operation.id)) throw new Error(`Duplicate Host operation id: ${operation.id}`);
        operations.set(operation.id, operation);
      }
    }
  }
  return Object.fromEntries(operations) as OperationById<OperationFromGroups<TGroups>>;
}

function collectHostOperations(groups: readonly HostOperationGroup[]): HostOperation[] {
  return groups.flatMap((group) => group.resources.flatMap((resource) => resource.operations));
}
