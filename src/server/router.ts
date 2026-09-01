import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bridgeContractIssues,
  type BridgeContractIssue,
  type BridgeJsonContract,
  type HostOperation,
  type HostOperationDecodedInput,
} from "#protocol";
import type { CompiledHostOperation } from "#protocol/compiler";
import type { BridgeSecurity } from "./bridge-security.js";
import type { BridgeState } from "./bridge-types.js";

export type BridgeRouteJsonSender = (response: ServerResponse, status: number, data: unknown) => void;
export type BridgeRouteBodyReader = (request: IncomingMessage, maxBytes?: number) => Promise<unknown>;

export interface BridgeRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  traceId: string;
  state: BridgeState;
  security: BridgeSecurity;
  sendJson: BridgeRouteJsonSender;
  readJsonBody: BridgeRouteBodyReader;
  reportContractViolation?(violation: BridgeContractViolation): void;
}

export type BridgeRoutePathMatcher = string | RegExp | ((context: BridgeRouteContext) => boolean);

export interface BridgeRoute {
  id: string;
  method?: string | string[];
  path?: BridgeRoutePathMatcher;
  contract?: BridgeJsonContract | HostOperation;
  handle(context: BridgeRouteContext): boolean | Promise<boolean>;
}

export type HostOperationRouteContext<TOperation extends HostOperation> = BridgeRouteContext &
  Readonly<{
    operation: CompiledHostOperation<TOperation>;
    input: HostOperationDecodedInput<TOperation>;
  }>;

export class BridgeContractViolation extends Error {
  readonly code: "bridge_request_contract_invalid" | "bridge_response_contract_invalid";
  readonly contractId: string;
  readonly issues: BridgeContractIssue[];
  readonly direction: "request" | "response";

  constructor(direction: "request" | "response", contractId: string, issues: BridgeContractIssue[]) {
    const code = direction === "request" ? "bridge_request_contract_invalid" : "bridge_response_contract_invalid";
    super(`${code}:${contractId}`);
    this.name = "BridgeContractViolation";
    this.code = code;
    this.contractId = contractId;
    this.issues = issues;
    this.direction = direction;
  }
}

export async function dispatchBridgeRoutes(
  routes: readonly BridgeRoute[],
  context: BridgeRouteContext,
): Promise<boolean> {
  for (const route of routes) {
    if (!routeMatches(route, context)) continue;
    if (await route.handle(contextWithContract(route, context))) return true;
  }
  return false;
}

function contextWithContract(route: BridgeRoute, context: BridgeRouteContext): BridgeRouteContext {
  const contract = route.contract;
  if (!contract) return context;
  if (isHostOperation(contract)) return contextWithHostOperation(contract, context);
  return {
    ...context,
    readJsonBody: async (request, maxBytes) => {
      const value = await context.readJsonBody(request, maxBytes);
      if (!contract.request) return value;
      const parsed = contract.request.safeParse(value);
      if (!parsed.success) {
        throw new BridgeContractViolation("request", contract.id, bridgeContractIssues(parsed.error));
      }
      return parsed.data;
    },
    sendJson: (response, status, data) => {
      if (status < 200 || status >= 300) {
        context.sendJson(response, status, data);
        return;
      }
      const parsed = contract.response.safeParse(data);
      if (!parsed.success) {
        const violation = new BridgeContractViolation("response", contract.id, bridgeContractIssues(parsed.error));
        context.reportContractViolation?.(violation);
        context.sendJson(response, 500, {
          ok: false,
          error: "bridge_response_contract_violation",
          contractId: contract.id,
        });
        return;
      }
      context.sendJson(response, status, parsed.data);
    },
  };
}

function contextWithHostOperation(operation: HostOperation, context: BridgeRouteContext): BridgeRouteContext {
  return {
    ...context,
    sendJson: (response, status, data) => {
      const declaredResponse =
        status === operation.success.status
          ? operation.success
          : operation.errors?.find((candidate) => candidate.status === status);
      if (!declaredResponse) {
        reportHostResponseViolation(operation, context, response, [
          { path: "$", code: `response_status_not_declared:${status}` },
        ]);
        return;
      }
      if (!declaredResponse.body) {
        if (data !== undefined) {
          reportHostResponseViolation(operation, context, response, [{ path: "$", code: "unexpected_response_body" }]);
          return;
        }
        context.sendJson(response, status, data);
        return;
      }
      const parsed = declaredResponse.body.safeParse(data);
      if (!parsed.success) {
        reportHostResponseViolation(operation, context, response, bridgeContractIssues(parsed.error));
        return;
      }
      context.sendJson(response, status, parsed.data);
    },
  };
}

export async function decodeHostOperationInput<TOperation extends HostOperation>(
  compiled: CompiledHostOperation<TOperation>,
  context: BridgeRouteContext,
): Promise<HostOperationRouteContext<TOperation>> {
  const operation = compiled.operation;
  const input: Record<string, unknown> = {};
  if (operation.params) {
    input.params = parseHostOperationPart(
      operation,
      "params",
      operation.params,
      operationPathParams(compiled, context.url.pathname),
    );
  }
  if (operation.query) {
    input.query = parseHostOperationPart(operation, "query", operation.query, operationQueryParams(context.url));
  }
  if (operation.body) {
    const value = await context.readJsonBody(context.request);
    input.body = parseHostOperationPart(operation, "body", operation.body, value);
  }
  return {
    ...context,
    operation: compiled,
    input: input as HostOperationDecodedInput<TOperation>,
  };
}

function parseHostOperationPart(
  operation: HostOperation,
  name: "params" | "query" | "body",
  schema: HostOperation["params"] | HostOperation["query"] | HostOperation["body"],
  value: unknown,
): unknown {
  if (!schema) return value;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = bridgeContractIssues(parsed.error).map((issue) => ({
    ...issue,
    path: issue.path === "$" ? name : `${name}.${issue.path}`,
  }));
  throw new BridgeContractViolation("request", operation.id, issues);
}

function operationPathParams(operation: CompiledHostOperation, pathname: string): Record<string, string> {
  const values = pathname.match(new RegExp(operation.path.regexpSource, "u"));
  if (!values) return {};
  return Object.fromEntries(
    operation.path.parameterNames.map((name, index) => {
      const value = values[index + 1] ?? "";
      try {
        return [name, decodeURIComponent(value)];
      } catch {
        throw new BridgeContractViolation("request", operation.id, [
          { path: `params.${name}`, code: "path_parameter_invalid_encoding" },
        ]);
      }
    }),
  );
}

function operationQueryParams(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    query[name] = values.length === 1 ? values[0]! : values;
  }
  return query;
}

function reportHostResponseViolation(
  operation: HostOperation,
  context: BridgeRouteContext,
  response: ServerResponse,
  issues: BridgeContractIssue[],
): void {
  const violation = new BridgeContractViolation("response", operation.id, issues);
  context.reportContractViolation?.(violation);
  context.sendJson(response, 500, {
    ok: false,
    error: "bridge_response_contract_violation",
    contractId: operation.id,
  });
}

function isHostOperation(contract: BridgeJsonContract | HostOperation): contract is HostOperation {
  return "method" in contract && "path" in contract && "success" in contract;
}

export function routeMatches(route: BridgeRoute, context: BridgeRouteContext): boolean {
  if (route.method) {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.includes(context.request.method ?? "GET")) {
      return false;
    }
  }

  if (!route.path) {
    return true;
  }
  if (typeof route.path === "string") {
    return context.url.pathname === route.path;
  }
  if (route.path instanceof RegExp) {
    return route.path.test(context.url.pathname);
  }
  return route.path(context);
}
