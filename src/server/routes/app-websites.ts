import type {
  getAppWebsiteOperation,
  prepareAppWebsiteOperation,
  configureAppWebsiteOperation,
  publishAppWebsiteOperation,
  activateAppWebsiteOperation,
  AppWebsiteState,
} from "#protocol";
import {
  configureAppWebsiteAudience,
  getLocalAppWebsiteState,
  prepareAppWebsite,
  readReviewedAppWebsiteArtifact,
} from "../../app-builder/website.js";
import { AppWebsiteRemoteError, requestAppWebsite } from "../app-website-client.js";
import { findDefaultAppGroupRoom } from "../app-room-ids.js";
import { appBuilderMemberId } from "../bridge-mounted-app-employees.js";
import { bridgeSessionUserHasRole, readAuthSession } from "../bridge-security.js";
import { resolveMountedAppTarget, type MountedAppTarget } from "../mounted-apps.js";
import { resolveReleaseControlConfig } from "../release-control-config.js";
import type { BridgeRouteContext, HostOperationRouteContext } from "../router.js";

async function authorizedTarget(context: BridgeRouteContext, appId: string) {
  const session = context.security
    ? await readAuthSession(context.request, context.response, context.security)
    : undefined;
  if (!bridgeSessionUserHasRole(session?.user, "admin")) {
    context.sendJson(context.response, 403, { ok: false, error: "admin_required" });
    return;
  }
  const target = resolveMountedAppTarget(context.state, appId);
  if (!target) context.sendJson(context.response, 404, { ok: false, error: "app_not_found" });
  return target;
}

async function websiteState(context: BridgeRouteContext, target: MountedAppTarget): Promise<AppWebsiteState> {
  const local = getLocalAppWebsiteState(target.appRoot);
  const state: AppWebsiteState = { ...local };
  const room = findDefaultAppGroupRoom(context.state.app.rooms.listRooms(), target.id);
  if (room) state.reviewTarget = { roomId: room.id, memberId: appBuilderMemberId(target.id) };
  const config = await resolveReleaseControlConfig(context.state, context.request, context.response, context.security);
  if (!config) {
    state.remoteError = "release_control_not_configured";
    return state;
  }
  const appId = state.inspection.config?.appId ?? target.manifest.id;
  try {
    state.site = await requestAppWebsite(config, encodeURIComponent(String(appId)));
  } catch (error) {
    if (!(error instanceof AppWebsiteRemoteError && error.code === "website_not_found")) {
      state.remoteError = error instanceof AppWebsiteRemoteError ? error.code : "website_service_unavailable";
    }
  }
  return state;
}
function sendError(context: BridgeRouteContext, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const code =
    error instanceof AppWebsiteRemoteError
      ? error.code
      : /^website_[a-z_]+$/.test(message)
        ? message
        : "website_operation_failed";
  context.sendJson(context.response, error instanceof AppWebsiteRemoteError ? error.status : 409, {
    ok: false,
    error: code,
  });
}
export async function handleGetAppWebsite(context: HostOperationRouteContext<typeof getAppWebsiteOperation>) {
  const target = await authorizedTarget(context, context.input.params.appId);
  if (!target) return;
  try {
    context.sendJson(context.response, 200, { ok: true, website: await websiteState(context, target) });
  } catch (error) {
    sendError(context, error);
  }
}
export async function handlePrepareAppWebsite(context: HostOperationRouteContext<typeof prepareAppWebsiteOperation>) {
  const target = await authorizedTarget(context, context.input.params.appId);
  if (!target) return;
  try {
    prepareAppWebsite(target.appRoot);
    context.sendJson(context.response, 200, { ok: true, website: await websiteState(context, target) });
  } catch (error) {
    sendError(context, error);
  }
}
export async function handleConfigureAppWebsite(
  context: HostOperationRouteContext<typeof configureAppWebsiteOperation>,
) {
  const target = await authorizedTarget(context, context.input.params.appId);
  if (!target) return;
  try {
    configureAppWebsiteAudience(target.appRoot, context.input.body.audience);
    context.sendJson(context.response, 200, { ok: true, website: await websiteState(context, target) });
  } catch (error) {
    sendError(context, error);
  }
}
export async function handlePublishAppWebsite(context: HostOperationRouteContext<typeof publishAppWebsiteOperation>) {
  const target = await authorizedTarget(context, context.input.params.appId);
  if (!target) return;
  try {
    const upload = readReviewedAppWebsiteArtifact(target.appRoot);
    if (upload.artifactSha256 !== context.input.body.artifactSha256) throw new Error("website_review_stale");
    const config = await resolveReleaseControlConfig(
      context.state,
      context.request,
      context.response,
      context.security,
    );
    if (!config) throw new AppWebsiteRemoteError("release_control_not_configured", 503);
    const site = await requestAppWebsite(config, "publish", {
      ...upload,
      expectedSha256: context.input.body.expectedSha256,
    });
    context.sendJson(context.response, 200, { ok: true, site });
  } catch (error) {
    sendError(context, error);
  }
}
export async function handleActivateAppWebsite(context: HostOperationRouteContext<typeof activateAppWebsiteOperation>) {
  const target = await authorizedTarget(context, context.input.params.appId);
  if (!target) return;
  try {
    const config = await resolveReleaseControlConfig(
      context.state,
      context.request,
      context.response,
      context.security,
    );
    if (!config) throw new AppWebsiteRemoteError("release_control_not_configured", 503);
    const appId = String(target.manifest.id);
    const site = await requestAppWebsite(config, encodeURIComponent(appId) + "/activate", context.input.body);
    context.sendJson(context.response, 200, { ok: true, site });
  } catch (error) {
    sendError(context, error);
  }
}
