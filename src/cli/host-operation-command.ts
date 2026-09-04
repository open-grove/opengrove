import {
  createOpenGroveClient,
  type HostOperationCall,
  type OpenGroveClient,
  type OpenGroveClientConfig,
} from "#client";
import type { HostOperation, HostOperationId, HostOperationOutput, RegisteredHostOperation } from "#protocol";
import { hostProtocol } from "#protocol/compiled";
import type { CompiledHostOperation, CompiledHostOperationGroup } from "#protocol/compiler";
import { APP_BRIDGE_TOKEN_HEADER } from "../identity.js";
import {
  assertHostOperationInputCatalog,
  decodeHostOperationCall,
  DEFAULT_HOST_OPERATION_BRIDGE_API_URL,
  hostOperationFields,
  hostOperationSchemaValueLabel,
  parseHostOperationOptions,
  type HostOperationDecodedCall,
} from "./host-operation-input.js";
import {
  HOST_OPERATION_CLI_EXIT,
  hostOperationCliError,
  hostOperationCliFailure,
  hostOperationCliSuccess,
  type HostOperationCliResult,
} from "./host-operation-output.js";

export { HOST_OPERATION_CLI_EXIT } from "./host-operation-output.js";
export type { HostOperationCliResult } from "./host-operation-output.js";

export type HostOperationCliCatalog = Readonly<{
  groups: readonly CompiledHostOperationGroup[];
  operations: readonly CompiledHostOperation[];
}>;

export type HostOperationCliOptions = Readonly<{
  catalog?: HostOperationCliCatalog;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  createClient?: (
    config: OpenGroveClientConfig & {
      baseUrl: string;
      baseUrlSource: "flag" | "environment" | "default";
      token?: string;
    },
  ) => OpenGroveClient | Promise<OpenGroveClient>;
}>;

export function isHostOperationCommand(
  args: readonly string[],
  catalog: HostOperationCliCatalog = hostProtocol,
): boolean {
  const groupId = args[0];
  const group = groupId ? catalog.groups.find((candidate) => candidate.id === groupId) : undefined;
  if (!group) return false;
  if (findOperation(args, catalog.operations)) return true;
  const scope = leadingCommandSegments(args);
  return scope.length <= 1 || group.resources.some((resource) => resource.id === scope[1]);
}

export function assertHostOperationCliCatalog(catalog: HostOperationCliCatalog = hostProtocol): void {
  assertHostOperationInputCatalog(catalog.operations);
}

export function renderHostOperationOverview(catalog: HostOperationCliCatalog = hostProtocol): string {
  assertHostOperationCliCatalog(catalog);
  if (catalog.groups.length === 0) return "";
  return catalog.groups
    .map((group) => {
      const commands = group.resources.flatMap((resource) =>
        resource.operations.map((operation) => `  ${operationCommandPath(operation).join(" ")}  ${operation.summary}`),
      );
      return [`${group.title}:`, ...commands].join("\n");
    })
    .join("\n\n");
}

/**
 * A Host operation command that has been resolved, validated, and is ready to
 * send. Ergonomic wrappers (for example `app release publish`) reuse this so
 * they share flag parsing, `--dry-run`, and the `--yes` gate with the generic
 * command path instead of re-implementing them.
 */
export type HostOperationPreparedCommand =
  | Readonly<{ kind: "result"; result: HostOperationCliResult }>
  | Readonly<{
      kind: "request";
      operation: CompiledHostOperation;
      call: HostOperationDecodedCall;
      client: OpenGroveClient;
    }>;

export function findHostOperationCommand(
  args: readonly string[],
  catalog: HostOperationCliCatalog = hostProtocol,
): CompiledHostOperation | undefined {
  return findOperation(args, catalog.operations);
}

type RegisteredHostOperationById<TId extends HostOperationId> = Extract<RegisteredHostOperation, { id: TId }>;

export function compiledHostOperation<TId extends HostOperationId>(
  id: TId,
  catalog: HostOperationCliCatalog = hostProtocol,
): CompiledHostOperation<RegisteredHostOperationById<TId>> {
  const operation = catalog.operations.find((candidate) => candidate.id === id);
  if (!operation) throw new Error(`Host operation ${id} is not part of the compiled Host Protocol.`);
  return operation as CompiledHostOperation<RegisteredHostOperationById<TId>>;
}

export function renderHostOperationCommandHelp(operation: CompiledHostOperation): string {
  return renderOperationHelp(operation);
}

export async function prepareHostOperationCommand(
  args: readonly string[],
  options: HostOperationCliOptions = {},
): Promise<HostOperationPreparedCommand> {
  const catalog = options.catalog ?? hostProtocol;
  assertHostOperationCliCatalog(catalog);
  if (!isHostOperationCommand(args, catalog)) {
    return { kind: "result", result: { handled: false, exitCode: HOST_OPERATION_CLI_EXIT.success } };
  }

  const operation = findOperation(args, catalog.operations);
  if (!operation) return { kind: "result", result: renderUnresolvedCommand(args, catalog) };
  const operationArgs = args.slice(operationCommandPath(operation).length);
  if (operationArgs.includes("--help") || operationArgs.includes("-h")) {
    return {
      kind: "result",
      result: {
        handled: true,
        exitCode: HOST_OPERATION_CLI_EXIT.success,
        stdout: renderOperationHelp(operation),
      },
    };
  }

  try {
    const parsed = parseHostOperationOptions(operation, operationArgs, options.env ?? process.env);
    const call = decodeHostOperationCall(operation.operation, operation, parsed.flatInput);
    if (parsed.dryRun) {
      return {
        kind: "result",
        result: hostOperationCliSuccess({
          ok: true,
          dryRun: true,
          operation: operation.id,
          risk: operation.risk,
          request: {
            method: operation.method,
            path: operation.path.template,
            ...call,
          },
        }),
      };
    }
    if (operation.risk === "high-risk-write" && !parsed.yes) {
      return {
        kind: "result",
        result: hostOperationCliError(
          HOST_OPERATION_CLI_EXIT.confirmationRequired,
          "confirmation",
          "confirmation_required",
          `Operation ${operation.id} is high-risk. Re-run with --yes after reviewing --dry-run.`,
          { operation: operation.id, risk: operation.risk },
        ),
      };
    }

    const clientConfig = {
      baseUrl: parsed.baseUrl,
      baseUrlSource: parsed.baseUrlSource,
      fetch: options.fetch,
      token: parsed.token,
      headers: parsed.token ? { [APP_BRIDGE_TOKEN_HEADER]: parsed.token } : undefined,
    };
    const client = options.createClient
      ? await options.createClient(clientConfig)
      : createOpenGroveClient(clientConfig);
    return { kind: "request", operation, call, client };
  } catch (error) {
    return { kind: "result", result: hostOperationCliFailure(operation.id, error) };
  }
}

export async function runHostOperationCommand(
  args: readonly string[],
  options: HostOperationCliOptions = {},
): Promise<HostOperationCliResult> {
  const prepared = await prepareHostOperationCommand(args, options);
  if (prepared.kind === "result") return prepared.result;
  const { operation, call, client } = prepared;
  try {
    const data = await requestHostOperation(client, operation.operation, call);
    return hostOperationCliSuccess({ ok: true, operation: operation.id, data });
  } catch (error) {
    return hostOperationCliFailure(operation.id, error);
  }
}

function renderUnresolvedCommand(args: readonly string[], catalog: HostOperationCliCatalog): HostOperationCliResult {
  const scope = leadingCommandSegments(args);
  const help = renderScopeHelp(scope, catalog);
  if (args.includes("--help") || args.includes("-h") || isKnownScope(scope, catalog)) {
    return { handled: true, exitCode: HOST_OPERATION_CLI_EXIT.success, stdout: help };
  }
  return hostOperationCliError(
    HOST_OPERATION_CLI_EXIT.validation,
    "validation",
    "command_not_found",
    `Unknown command: ${scope.join(" ")}`,
    { help },
  );
}

function findOperation(
  args: readonly string[],
  operations: readonly CompiledHostOperation[],
): CompiledHostOperation | undefined {
  return operations
    .slice()
    .sort((left, right) => operationCommandPath(right).length - operationCommandPath(left).length)
    .find((operation) => operationCommandPath(operation).every((segment, index) => args[index] === segment));
}

function operationCommandPath(operation: CompiledHostOperation): string[] {
  return [operation.groupId, operation.resourceId, ...operation.methodName.split(".")];
}

function leadingCommandSegments(args: readonly string[]): string[] {
  const optionIndex = args.findIndex((arg) => arg.startsWith("-"));
  return args.slice(0, optionIndex === -1 ? args.length : optionIndex);
}

function isKnownScope(scope: readonly string[], catalog: HostOperationCliCatalog): boolean {
  if (scope.length === 1) return catalog.groups.some((group) => group.id === scope[0]);
  if (scope.length === 2) {
    return catalog.groups.some(
      (group) => group.id === scope[0] && group.resources.some((resource) => resource.id === scope[1]),
    );
  }
  return false;
}

function renderScopeHelp(scope: readonly string[], catalog: HostOperationCliCatalog): string {
  const matchingOperations = catalog.operations.filter((operation) => {
    const path = operationCommandPath(operation);
    return scope.every((segment, index) => path[index] === segment);
  });
  const shownOperations = matchingOperations.length > 0 ? matchingOperations : catalog.operations;
  const heading = scope.length > 0 ? `OpenGrove ${scope.join(" ")}` : "OpenGrove Host commands";
  return [
    heading,
    "",
    "Usage:",
    ...shownOperations.map((operation) => `  opengrove ${operationCommandPath(operation).join(" ")} [options]`),
    "",
    "Commands:",
    ...shownOperations.map(
      (operation) => `  ${operationCommandPath(operation).slice(scope.length).join(" ")}  ${operation.summary}`,
    ),
  ].join("\n");
}

function renderOperationHelp(operation: CompiledHostOperation): string {
  const fieldLines = hostOperationFields(operation).map((field) => {
    const description = readString(field.schema.description);
    const required = field.required ? " Required." : "";
    const defaultValue = Object.hasOwn(field.schema, "default")
      ? ` Default: ${JSON.stringify(field.schema.default)}.`
      : "";
    return `  --${field.flag} <${hostOperationSchemaValueLabel(field.schema)}>  ${asSentence(description ?? field.name)}${required}${defaultValue}`;
  });
  return [
    operation.summary,
    "",
    operation.description,
    "",
    "Usage:",
    `  opengrove ${operationCommandPath(operation).join(" ")} [options]`,
    "",
    "Operation options:",
    ...(fieldLines.length > 0 ? fieldLines : ["  (none)"]),
    "",
    "Common options:",
    "  --input <json>     Provide all operation fields as one JSON object; explicit field flags override it.",
    `  --base-url <url>   Bridge API base URL. Default: OPENGROVE_BRIDGE_URL or ${DEFAULT_HOST_OPERATION_BRIDGE_API_URL}.`,
    "  --token <token>    Bridge token. Overrides the saved account session. Default: OPENGROVE_BRIDGE_TOKEN.",
    "  --format <format>  Output format. Currently: json (default).",
    "  --dry-run          Validate and print the request without sending it.",
    "  --yes              Confirm a high-risk write.",
    "  --help, -h         Show this help.",
    "",
    `Risk: ${operation.risk}`,
  ].join("\n");
}

export async function requestHostOperation<TOperation extends HostOperation>(
  client: OpenGroveClient,
  operation: TOperation,
  call: HostOperationDecodedCall,
): Promise<HostOperationOutput<TOperation>> {
  return client.request(operation, call as HostOperationCall<TOperation>);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asSentence(value: string): string {
  return /[.!?]$/u.test(value) ? value : `${value}.`;
}
