import type { BridgeContractIssue } from "#protocol";

export class OpenGroveProtocolError extends Error {
  readonly code: "client_request_contract_invalid" | "client_response_contract_invalid";
  readonly operationId: string;
  readonly issues: BridgeContractIssue[];
  readonly direction: "request" | "response";

  constructor(direction: "request" | "response", operationId: string, issues: BridgeContractIssue[]) {
    const code = direction === "request" ? "client_request_contract_invalid" : "client_response_contract_invalid";
    super(`${code}:${operationId}`);
    this.name = "OpenGroveProtocolError";
    this.code = code;
    this.operationId = operationId;
    this.issues = issues;
    this.direction = direction;
  }
}

export class OpenGroveClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly declared: boolean;
  readonly traceId?: string;
  readonly payload?: unknown;

  constructor(
    message: string,
    options: { status: number; code?: string; declared: boolean; traceId?: string; payload?: unknown },
  ) {
    super(message);
    this.name = "OpenGroveClientError";
    this.status = options.status;
    this.code = options.code;
    this.declared = options.declared;
    this.traceId = options.traceId;
    this.payload = options.payload;
  }
}
