import type { ScheduleAppUpdatesOperation } from "#protocol";
import { scheduleInstalledAppStoreUpdatesAfterAuth } from "../app-store-auto-updates.js";
import { releaseControlRegistryConfig } from "../app-store-registry.js";
import { resolveWwRuntimeAuth } from "../bridge-security.js";
import { recordProblem } from "../problem-records.js";
import type { HostOperationRouteContext } from "../router.js";
import { readWwProviderLocalState, wwProviderAccountMatches } from "../ww-provider-local-state.js";

export async function handleScheduleAppUpdatesOperation(
  context: HostOperationRouteContext<ScheduleAppUpdatesOperation>,
): Promise<true> {
  const { request, response, security, state, traceId, sendJson } = context;
  try {
    const auth = await resolveWwRuntimeAuth(request, response, security);
    if (auth.status === "unauthenticated") {
      sendJson(response, 401, { error: "not_authenticated" });
      return true;
    }
    if (auth.status === "temporarily_unavailable") throw auth.error;
    if (auth.verification === "stale") throw new Error("app_update_account_verification_unavailable");

    // A trusted desktop Bridge token grants local access, but does not make a
    // different Cloud account the owner of these installed Apps.
    const localOwner = readWwProviderLocalState(state).ownerUserId;
    if (
      localOwner &&
      !wwProviderAccountMatches(state, { issuer: auth.session.auth.baseUrl, userId: auth.session.auth.userId })
    ) {
      sendJson(response, 403, { error: "workspace_owner_mismatch" });
      return true;
    }
    const schedule = scheduleInstalledAppStoreUpdatesAfterAuth({
      state,
      request,
      packageRegistryConfig: releaseControlRegistryConfig(auth.session.auth.accessToken),
      userId: auth.session.auth.userId,
      traceId,
    });
    sendJson(response, 200, { ok: true, ...schedule });
  } catch (error) {
    const problem = recordProblem(state, {
      traceId,
      category: "bridge",
      phase: "app-update-schedule",
      code: "app_update_schedule_unavailable",
      error,
      retryable: true,
    });
    sendJson(response, 503, {
      error: "app_update_schedule_unavailable",
      incidentId: problem.incidentId,
      traceId: problem.traceId,
    });
  }
  return true;
}
