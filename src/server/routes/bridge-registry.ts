import type { BridgeRoute, BridgeRouteContext } from "../router.js";
import { hostContractById } from "#protocol/compiled";
import { handleA2ARoute } from "./a2a.js";
import { handleAppStoreRoute } from "./app-store.js";
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
import { handlePendingActionsRoute } from "./pending-actions.js";
import { moduleRoute, operationRoute } from "./registry-utils.js";
import { handleRoomLedgerCapabilityRoute } from "./room-ledger.js";
import { handleCreateRoomMessageOperation } from "./rooms/message-routes.js";
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
    operationRoute(hostContractById["auth.email-code.create"], handleCreateAuthEmailCodeOperation),
    operationRoute(hostContractById["auth.session.create"], handleCreateAuthSessionOperation),
    operationRoute(hostContractById["auth.session.get"], handleGetAuthSessionOperation),
    operationRoute(hostContractById["auth.session.delete"], handleDeleteAuthSessionOperation),
    moduleRoute("auth", /^\/auth\//, (context) => handleAuthRoute(context)),
    moduleRoute("settings", /^\/settings(?:\/|$)/, (context) => handleSettingsRoute(context)),
    moduleRoute("voice", /^\/voice\//, (context) => handleVoiceRoute(context)),
    moduleRoute("withdrawal", isWithdrawalRoute, (context) => handleWithdrawalRoute(context)),
    moduleRoute("room-ledger", "/room-ledger/read", (context) => handleRoomLedgerCapabilityRoute(context)),
    moduleRoute("app-store", /^\/app-store(?:\/|$)/, (context) => handleAppStoreRoute(context)),
    moduleRoute("a2a", /^\/a2a\//, (context) => handleA2ARoute(context)),
    moduleRoute("workspace", "/workspace/choose-directory", (context) => handleWorkspaceRoute(context)),
    moduleRoute("workspace-resources", /^\/workspace\/resource(?:\/|$)/, (context) =>
      handleWorkspaceResourceRoute(context),
    ),
    moduleRoute("local-resources", /^\/local-resource(?:\/|$)/, (context) => handleLocalResourceRoute(context)),
    moduleRoute("pending-actions", isPendingActionRoute, (context) => handlePendingActionsRoute(context)),
    ...createStateRoutes(),
    moduleRoute("knowledge", /^\/knowledge(?:\/|$)/, (context) => handleKnowledgeRoute(context)),
    moduleRoute("extensions", /^\/extensions(?:\/|$)/, (context) => handleExtensionsRoute(context)),
    moduleRoute("apps", /^\/apps\//, (context) => handleAppsRoute(context)),
    ...createInventoryRoutes(),
    operationRoute(hostContractById["room.message.create"], handleCreateRoomMessageOperation),
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

function isPendingActionRoute(context: BridgeRouteContext): boolean {
  return (
    context.url.pathname === "/approvals" ||
    context.url.pathname === "/questions" ||
    /^\/approvals\/[^/]+\/(approve|reject)$/.test(context.url.pathname) ||
    /^\/questions\/[^/]+\/(answer|decline)$/.test(context.url.pathname)
  );
}
