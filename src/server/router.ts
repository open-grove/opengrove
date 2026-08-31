import type { IncomingMessage, ServerResponse } from "node:http";
import { bridgeContractIssues, type BridgeContractIssue, type BridgeJsonContract } from "#agent-protocol";
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
  contract?: BridgeJsonContract;
  handle(context: BridgeRouteContext): boolean | Promise<boolean>;
}

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
