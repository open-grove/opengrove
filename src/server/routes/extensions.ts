import { recreateBridgeApp } from "../bridge-state.js";
import { hostContractById } from "#protocol/compiled";
import { operationRoute } from "./registry-utils.js";
import type { BridgeRoute } from "../router.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BRIDGE_KERNEL_IDS } from "../bridge-types.js";
import type { BridgeKernelId, BridgeState } from "../bridge-types.js";
import {
  deleteDeployments,
  importSkillToLibrary,
  openExtensionLocalPath,
  publishSkillToKernels,
  republishSkillDeployments,
  setDeploymentEnabled,
  unpublishSkillFromKernels,
} from "../../extensions/manager.js";
import { scanExtensionInventory } from "../../extensions/scanner.js";
import type { ExtensionKind } from "../../extensions/types.js";

type SendJson = (response: ServerResponse, status: number, data: unknown) => void;
type ReadJsonBody = (request: IncomingMessage) => Promise<unknown>;

export function createExtensionRoutes(): BridgeRoute[] {
  return [
    hostContractById["extension.extension.list"],
    hostContractById["extension.skill.import"],
    hostContractById["extension.skill.publish"],
    hostContractById["extension.skill.republish"],
    hostContractById["extension.skill.unpublish"],
    hostContractById["extension.deployment.enable"],
    hostContractById["extension.deployment.disable"],
    hostContractById["extension.deployment.delete"],
  ].map((operation) =>
    operationRoute<(typeof operation)["operation"]>(operation, async (context) => {
      await handleExtensionsRoute({
        ...context,
        readJsonBody: async () => context.input.body,
        includeSystem: context.input.query.includeSystem ?? false,
        sendJson(response, status, data) {
          if (operation.method !== "GET" && status >= 200 && status < 300) {
            // Rebuild through the existing hot-reload boundary, which retains active
            // producers while retiring cached adapters for future tasks.
            const root = context.state.rootState ?? context.state;
            root.store.saveFrom(root.app);
            recreateBridgeApp(root);
          }
          context.sendJson(response, status, data);
        },
      });
    }),
  );
}

export async function handleExtensionsRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  state: BridgeState;
  sendJson: SendJson;
  readJsonBody: ReadJsonBody;
  includeSystem?: boolean;
}): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = options;
  const includeSystem =
    options.includeSystem ??
    (url.searchParams.get("includeSystem") === "1" || url.searchParams.get("includeSystem") === "true");

  if (request.method === "GET" && url.pathname === "/extensions") {
    sendJson(response, 200, {
      ok: true,
      extensions: scanExtensionInventory(state, { includeSystem }),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/extensions/skills/import") {
    const payload = record(await readJsonBody(request));
    const result = importSkillToLibrary(state, {
      sourcePath: stringValue(payload.sourcePath),
      deploymentId: stringValue(payload.deploymentId),
      itemId: stringValue(payload.itemId),
      name: stringValue(payload.name),
      replace: payload.replace === true,
    });
    sendJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      result,
      extensions: scanExtensionInventory(state, { includeSystem }),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/extensions/open-local-path") {
    const payload = record(await readJsonBody(request));
    const result = await openExtensionLocalPath(stringValue(payload.path));
    sendJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      result,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/extensions/skills/publish") {
    const payload = record(await readJsonBody(request));
    const result = publishSkillToKernels(state, {
      librarySkillId: stringValue(payload.librarySkillId),
      sourcePath: stringValue(payload.sourcePath),
      deploymentId: stringValue(payload.deploymentId),
      itemId: stringValue(payload.itemId),
      name: stringValue(payload.name),
      targetKernelIds: kernelIds(payload.targetKernelIds),
      scope: payload.scope === "project" ? "project" : "user",
      replace: payload.replace === true,
    });
    sendJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      result,
      extensions: scanExtensionInventory(state, { includeSystem }),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/extensions/skills/republish") {
    const payload = record(await readJsonBody(request));
    const result = republishSkillDeployments(state, {
      deploymentIds: stringArray(payload.deploymentIds),
      itemId: stringValue(payload.itemId),
      name: stringValue(payload.name),
      targetKernelIds: kernelIds(payload.targetKernelIds),
    });
    sendJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      result,
      extensions: scanExtensionInventory(state, { includeSystem }),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/extensions/skills/unpublish") {
    const payload = record(await readJsonBody(request));
    const result = unpublishSkillFromKernels(state, {
      deploymentIds: stringArray(payload.deploymentIds),
      itemId: stringValue(payload.itemId),
      name: stringValue(payload.name),
      targetKernelIds: kernelIds(payload.targetKernelIds),
      forceExternal: payload.forceExternal === true,
      deleteLibrary: payload.deleteLibrary === true,
    });
    sendJson(response, 200, {
      ok: true,
      result,
      extensions: scanExtensionInventory(state, { includeSystem }),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/extensions/deployments/enable") {
    const payload = record(await readJsonBody(request));
    const result = setDeploymentEnabled(state, {
      deploymentIds: stringArray(payload.deploymentIds),
      itemId: stringValue(payload.itemId),
      kind: extensionKind(payload.kind),
      enabled: payload.enabled !== false,
      forceExternal: payload.forceExternal === true,
      reason: stringValue(payload.reason),
    });
    sendJson(response, 200, {
      ok: true,
      result,
      extensions: scanExtensionInventory(state, { includeSystem }),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/extensions/deployments/disable") {
    const payload = record(await readJsonBody(request));
    const result = setDeploymentEnabled(state, {
      deploymentIds: stringArray(payload.deploymentIds),
      itemId: stringValue(payload.itemId),
      kind: extensionKind(payload.kind),
      enabled: false,
      forceExternal: payload.forceExternal === true,
      reason: stringValue(payload.reason),
    });
    sendJson(response, 200, {
      ok: true,
      result,
      extensions: scanExtensionInventory(state, { includeSystem }),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/extensions/deployments/delete") {
    const payload = record(await readJsonBody(request));
    const result = deleteDeployments(state, {
      deploymentIds: stringArray(payload.deploymentIds),
      itemId: stringValue(payload.itemId),
      kind: extensionKind(payload.kind),
      forceExternal: payload.forceExternal === true,
      deleteLibrary: payload.deleteLibrary === true,
    });
    sendJson(response, 200, {
      ok: true,
      result,
      extensions: scanExtensionInventory(state, { includeSystem }),
    });
    return true;
  }

  return false;
}

function kernelIds(value: unknown): BridgeKernelId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is BridgeKernelId => typeof item === "string" && BRIDGE_KERNEL_IDS.includes(item as BridgeKernelId),
  );
}

function extensionKind(value: unknown): ExtensionKind | undefined {
  return value === "skill" ||
    value === "mcp" ||
    value === "plugin" ||
    value === "hook" ||
    value === "tool" ||
    value === "cli"
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
