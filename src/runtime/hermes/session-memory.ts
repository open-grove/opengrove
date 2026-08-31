import type { AgentTurnRequest, JsonObject } from "../../core.js";

export function readRememberedHermesGatewaySession(
  request: AgentTurnRequest,
  runtimeBindingFingerprint: string | undefined,
): { sessionId: string } | undefined {
  const current = request.context.sessions.get(request.context.sessionId);
  const fingerprint = runtimeBindingFingerprint || "native";
  const sessionsByFingerprint = asObject(current?.metadata?.hermesGatewaySessionIds);
  const sessionId = readString(sessionsByFingerprint, fingerprint);
  return sessionId ? { sessionId } : undefined;
}

export function rememberHermesGatewaySession(
  request: AgentTurnRequest,
  nativeSessionId: string,
  runtimeBindingFingerprint: string | undefined,
): void {
  const current = request.context.sessions.get(request.context.sessionId);
  const fingerprint = runtimeBindingFingerprint || "native";
  const currentSessionIds = asObject(current?.metadata?.hermesGatewaySessionIds);
  const hermesGatewaySessionIds: JsonObject = {};
  for (const [key, value] of Object.entries(currentSessionIds)) {
    if (typeof value === "string") {
      hermesGatewaySessionIds[key] = value;
    }
  }
  hermesGatewaySessionIds[fingerprint] = nativeSessionId;
  const metadata: JsonObject = {
    ...(current?.metadata ?? {}),
    hermesGatewaySessionIds,
  };
  request.context.sessions.ensureSession({
    id: request.context.sessionId,
    activity: request.context.activity,
    metadata,
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
