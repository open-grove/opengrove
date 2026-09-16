import { handleInspectNetworkAccount, handleConnectNetworkAccount, handleAddNetworkContact } from "./network.js";
import type { BridgeRoute, BridgeRouteContext } from "../router.js";
import { hostContractById } from "#protocol/compiled";
import { handleA2ARoute } from "./a2a.js";
import { handleAppStoreRoute } from "./app-store.js";
import { handleScheduleAppUpdatesOperation } from "./app-updates.js";
import {
  handleAbandonAppReleaseOperation,
  handleGetAppReleaseProgressOperation,
  handleGetAppReleaseStatusOperation,
  handleKeepLocalAppReleaseOperation,
  handlePrepareAppReleaseOperation,
  handlePublishAppReleaseOperation,
  handleReconcileAppReleaseOperation,
} from "./app-release.js";
import { handleAppsRoute } from "./apps.js";
import { createAskRoutes } from "./ask.js";
import {
  handleAuthRoute,
  handleCreateAuthEmailCodeOperation,
  handleCreateAuthSessionOperation,
  handleDeleteAuthSessionOperation,
  handleGetAuthSessionOperation,
} from "./auth.js";
import { createHealthRoutes, createInventoryRoutes } from "./core.js";
import { handleExtensionsRoute } from "./extensions.js";
import { handleKnowledgeRoute } from "./knowledge.js";
import { handleLocalResourceRoute } from "./local-resources.js";
import { createPendingActionRoutes } from "./pending-actions.js";
import { moduleRoute, operationRoute } from "./registry-utils.js";
import { handleRoomLedgerCapabilityRoute } from "./room-ledger.js";
import {
  handleCreateRoomMessageOperation,
  handleListRoomMessagesOperation,
  handleRecordRoomMessageOperation,
  handleCancelRoomMessageOperation,
  handleUpdateRoomMessageOperation,
  handleDeleteRoomMessageOperation,
} from "./rooms/message-routes.js";
import {
  handleCreateRoomOperation,
  handleListRoomsOperation,
  handleListRoomEventsOperation,
  handleOpenDirectRoomOperation,
  handleUpdateRoomOperation,
  handleMarkRoomReadOperation,
} from "./rooms/collection-routes.js";
import {
  handleUpsertEmployeeOperation,
  handleUpdateEmployeeOperation,
  handleRestoreEmployeeDefaultsOperation,
  handleAddRoomMemberOperation,
  handleJoinRoomMemberOperation,
  handleRemoveRoomMemberOperation,
} from "./rooms/member-routes.js";
import { handleRoomsRoute } from "./rooms.js";
import { createRoutineRoutes } from "./routines.js";
import { handleSettingsRoute } from "./settings.js";
import { createStateRoutes } from "./state.js";
import { handleVoiceRoute } from "./voice.js";
import { handleWithdrawalRoute } from "./withdrawal.js";
import { handleWorkspaceRoute } from "./workspace.js";
import { handleWorkspaceResourceRoute } from "./workspace-resources.js";

export function createBridgeRoutes(): BridgeRoute[] {
  return [
    ...createHealthRoutes(),
    operationRoute(hostContractById["network.account.inspect"], handleInspectNetworkAccount),
    operationRoute(hostContractById["network.account.connect"], handleConnectNetworkAccount),
    operationRoute(hostContractById["network.contact.add"], handleAddNetworkContact),
    operationRoute(hostContractById["auth.email-code.create"], handleCreateAuthEmailCodeOperation),
    operationRoute(hostContractById["auth.session.create"], handleCreateAuthSessionOperation),
    operationRoute(hostContractById["auth.session.get"], handleGetAuthSessionOperation),
    operationRoute(hostContractById["auth.session.delete"], handleDeleteAuthSessionOperation),
    moduleRoute("auth", /^\/auth\//, (context) => handleAuthRoute(context)),
    moduleRoute("settings", /^\/settings(?:\/|$)/, (context) => handleSettingsRoute(context)),
    moduleRoute("voice", /^\/voice\//, (context) => handleVoiceRoute(context)),
    moduleRoute("withdrawal", isWithdrawalRoute, (context) => handleWithdrawalRoute(context)),
    moduleRoute("room-ledger", "/room-ledger/read", (context) => handleRoomLedgerCapabilityRoute(context)),
    operationRoute(hostContractById["app.update.schedule"], handleScheduleAppUpdatesOperation),
    moduleRoute("app-store", /^\/app-store(?:\/|$)/, (context) => handleAppStoreRoute(context)),
    moduleRoute("a2a", /^\/a2a\//, (context) => handleA2ARoute(context)),
    moduleRoute("workspace", "/workspace/choose-directory", (context) => handleWorkspaceRoute(context)),
    moduleRoute("workspace-resources", /^\/workspace\/resource(?:\/|$)/, (context) =>
      handleWorkspaceResourceRoute(context),
    ),
    moduleRoute("local-resources", /^\/local-resource(?:\/|$)/, (context) => handleLocalResourceRoute(context)),
    ...createPendingActionRoutes(),
    ...createStateRoutes(),
    moduleRoute("knowledge", /^\/knowledge(?:\/|$)/, (context) => handleKnowledgeRoute(context)),
    moduleRoute("extensions", /^\/extensions(?:\/|$)/, (context) => handleExtensionsRoute(context)),
    operationRoute(hostContractById["app.release.prepare"], handlePrepareAppReleaseOperation),
    operationRoute(hostContractById["app.release.publish"], handlePublishAppReleaseOperation),
    operationRoute(hostContractById["app.release.status"], handleGetAppReleaseStatusOperation),
    operationRoute(hostContractById["app.release.progress"], handleGetAppReleaseProgressOperation),
    operationRoute(hostContractById["app.release.reconcile"], handleReconcileAppReleaseOperation),
    operationRoute(hostContractById["app.release.abandon"], handleAbandonAppReleaseOperation),
    operationRoute(hostContractById["app.release.keep-local"], handleKeepLocalAppReleaseOperation),
    moduleRoute("apps", /^\/apps\//, (context) => handleAppsRoute(context)),
    ...createInventoryRoutes(),
    operationRoute(hostContractById["room.message.delete"], handleDeleteRoomMessageOperation),
    operationRoute(hostContractById["room.message.update"], handleUpdateRoomMessageOperation),
    operationRoute(hostContractById["room.message.cancel"], handleCancelRoomMessageOperation),
    operationRoute(hostContractById["room.message.record"], handleRecordRoomMessageOperation),
    operationRoute(hostContractById["room.message.list"], handleListRoomMessagesOperation),
    operationRoute(hostContractById["room.message.create"], handleCreateRoomMessageOperation),
    operationRoute(hostContractById["room.direct.open"], handleOpenDirectRoomOperation),
    operationRoute(hostContractById["room.event.list"], handleListRoomEventsOperation),
    operationRoute(hostContractById["room.room.list"], handleListRoomsOperation),
    operationRoute(hostContractById["room.room.create"], handleCreateRoomOperation),
    operationRoute(hostContractById["room.room.update"], handleUpdateRoomOperation),
    operationRoute(hostContractById["room.room.read"], handleMarkRoomReadOperation),
    operationRoute(hostContractById["employee.employee.upsert"], handleUpsertEmployeeOperation),
    operationRoute(hostContractById["employee.employee.update"], handleUpdateEmployeeOperation),
    operationRoute(hostContractById["employee.employee.restore-defaults"], handleRestoreEmployeeDefaultsOperation),
    operationRoute(hostContractById["room.member.add"], handleAddRoomMemberOperation),
    operationRoute(hostContractById["room.member.join"], handleJoinRoomMemberOperation),
    operationRoute(hostContractById["room.member.remove"], handleRemoveRoomMemberOperation),
    moduleRoute("rooms", /^\/rooms(?:\/|$)/, (context) => handleRoomsRoute(context)),
    ...createRoutineRoutes(),
    ...createAskRoutes(),
  ];
}

function isWithdrawalRoute(context: BridgeRouteContext): boolean {
  return (
    context.url.pathname === "/v1/users/me" ||
    context.url.pathname.startsWith("/v1/payment/") ||
    context.url.pathname.startsWith("/v1/stripe-connect/") ||
    context.url.pathname === "/v1/payout-orders" ||
    /^\/v1\/payout-orders\/[^/]+$/.test(context.url.pathname) ||
    /^\/v1\/payout-orders\/[^/]+\/sync$/.test(context.url.pathname)
  );
}
