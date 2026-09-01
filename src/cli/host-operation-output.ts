import { OpenGroveClientError, OpenGroveProtocolError } from "#client";
import { HostOperationCliUsageError } from "./host-operation-input.js";

export const HOST_OPERATION_CLI_EXIT = {
  success: 0,
  api: 1,
  validation: 2,
  authentication: 3,
  network: 4,
  internal: 5,
  policy: 6,
  confirmationRequired: 10,
} as const;

export type HostOperationCliErrorType =
  | "validation"
  | "authentication"
  | "authorization"
  | "config"
  | "network"
  | "api"
  | "policy"
  | "internal"
  | "confirmation";

export type HostOperationCliResult = Readonly<{
  handled: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}>;

export function hostOperationCliSuccess(payload: Readonly<Record<string, unknown>>): HostOperationCliResult {
  return {
    handled: true,
    exitCode: HOST_OPERATION_CLI_EXIT.success,
    stdout: JSON.stringify(payload, null, 2),
  };
}

export function hostOperationCliError(
  exitCode: number,
  type: HostOperationCliErrorType,
  subtype: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): HostOperationCliResult {
  return {
    handled: true,
    exitCode,
    stderr: JSON.stringify({ ok: false, ...details, error: { type, subtype, message } }, null, 2),
  };
}

export function hostOperationCliFailure(operationId: string, error: unknown): HostOperationCliResult {
  if (error instanceof HostOperationCliUsageError) {
    return hostOperationCliError(HOST_OPERATION_CLI_EXIT.validation, "validation", error.code, error.message, {
      operation: operationId,
      ...(error.issues ? { issues: error.issues } : {}),
    });
  }
  if (error instanceof OpenGroveClientError) {
    const type = error.status === 401 ? "authentication" : error.status === 403 ? "authorization" : "api";
    return hostOperationCliError(
      type === "api" ? HOST_OPERATION_CLI_EXIT.api : HOST_OPERATION_CLI_EXIT.authentication,
      type,
      error.code ?? "host_request_failed",
      error.message,
      {
        operation: operationId,
        status: error.status,
        declared: error.declared,
        ...(error.traceId ? { traceId: error.traceId } : {}),
      },
    );
  }
  if (error instanceof OpenGroveProtocolError) {
    return hostOperationCliError(HOST_OPERATION_CLI_EXIT.internal, "internal", error.code, error.message, {
      operation: operationId,
      direction: error.direction,
      issues: error.issues,
    });
  }
  if (error instanceof TypeError) {
    return hostOperationCliError(HOST_OPERATION_CLI_EXIT.network, "network", "transport_failed", error.message, {
      operation: operationId,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return hostOperationCliError(HOST_OPERATION_CLI_EXIT.internal, "internal", "internal_error", message, {
    operation: operationId,
  });
}
