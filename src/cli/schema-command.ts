import type { CompiledHostOperation } from "#protocol/compiler";
import type { HostOperationCliCatalog } from "./host-operation-command.js";
import { hostOperationFields } from "./host-operation-input.js";
import {
  HOST_OPERATION_CLI_EXIT,
  hostOperationCliError,
  hostOperationCliSuccess,
  type HostOperationCliResult,
} from "./host-operation-output.js";

/** Schema discovery is local: it must never acquire credentials or contact a Host. */
export function runSchemaCommand(args: readonly string[], catalog: HostOperationCliCatalog): HostOperationCliResult {
  if (args.includes("--help") || args.includes("-h")) {
    return {
      handled: true,
      exitCode: 0,
      stdout: [
        "Inspect Host command schemas without connecting to a Bridge.",
        "",
        "Usage:",
        "  opengrove schema                         List business domains.",
        "  opengrove schema room                    List a domain's operations.",
        "  opengrove schema room.message.create     Describe one operation.",
        "  opengrove schema room message create     Equivalent space-separated path.",
      ].join("\n"),
    };
  }
  const path = args.flatMap((arg) => arg.split("."));
  if (path.some((part) => !/^[a-z][a-z0-9-]*$/u.test(part))) {
    return hostOperationCliError(
      HOST_OPERATION_CLI_EXIT.validation,
      "validation",
      "invalid_schema_path",
      "Use a domain, resource, or operation path, such as room.message.create.",
    );
  }
  if (path.length === 0) {
    return hostOperationCliSuccess({
      ok: true,
      data: catalog.groups.map((group) => ({
        id: group.id,
        title: group.title,
        description: group.description,
        resources: group.resources.map((resource) => ({
          id: resource.id,
          title: resource.title,
          operationCount: resource.operations.length,
        })),
      })),
    });
  }
  const id = path.join(".");
  const operation = catalog.operations.find((candidate) => candidate.id === id);
  if (operation) return hostOperationCliSuccess({ ok: true, data: describeOperation(operation) });
  const operations = catalog.operations.filter((candidate) => candidate.id.startsWith(`${id}.`));
  if (operations.length > 0) {
    return hostOperationCliSuccess({
      ok: true,
      data: operations.map((entry) => ({
        id: entry.id,
        command: `opengrove ${entry.id.split(".").join(" ")}`,
        summary: entry.summary,
        risk: entry.risk,
      })),
    });
  }
  return hostOperationCliError(
    HOST_OPERATION_CLI_EXIT.validation,
    "validation",
    "schema_not_found",
    `Unknown schema: ${id}. Run opengrove schema to discover domains.`,
  );
}

function describeOperation(operation: CompiledHostOperation) {
  return {
    id: operation.id,
    command: `opengrove ${operation.id.split(".").join(" ")}`,
    summary: operation.summary,
    description: operation.description,
    risk: operation.risk,
    method: operation.method,
    path: operation.path.template,
    input: Object.fromEntries(
      (["params", "query", "body"] as const).flatMap((section) => {
        const value = operation.input[section];
        return value ? [[section, value.jsonSchema]] : [];
      }),
    ),
    flags: hostOperationFields(operation),
    responses: {
      success: operation.success,
      additionalSuccesses: operation.additionalSuccesses,
      errors: operation.errors,
    },
  };
}
