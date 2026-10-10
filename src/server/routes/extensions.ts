import { hostContractById } from "#protocol/compiled";
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
import type { ExtensionActionResult } from "../../extensions/types.js";
import { recreateBridgeApp } from "../bridge-state.js";
import { record, stringValue } from "../http-utils.js";
import type { BridgeRoute, BridgeRouteContext } from "../router.js";
import { operationRoute, route } from "./registry-utils.js";

export function createExtensionRoutes(): BridgeRoute[] {
  return [
    operationRoute(hostContractById["extension.extension.list"], (context) => {
      context.sendJson(context.response, 200, {
        ok: true,
        extensions: scanExtensionInventory(context.state, context.input.query),
      });
    }),
    operationRoute(hostContractById["extension.skill.import"], (context) => {
      sendMutation(context, importSkillToLibrary(context.state, context.input.body), context.input.query);
    }),
    operationRoute(hostContractById["extension.skill.publish"], (context) => {
      sendMutation(context, publishSkillToKernels(context.state, context.input.body), context.input.query);
    }),
    operationRoute(hostContractById["extension.skill.republish"], (context) => {
      sendMutation(context, republishSkillDeployments(context.state, context.input.body), context.input.query);
    }),
    operationRoute(hostContractById["extension.skill.unpublish"], (context) => {
      sendMutation(context, unpublishSkillFromKernels(context.state, context.input.body), context.input.query);
    }),
    operationRoute(hostContractById["extension.deployment.enable"], (context) => {
      const input = context.input.body;
      sendMutation(
        context,
        setDeploymentEnabled(context.state, { ...input, enabled: input.enabled !== false }),
        context.input.query,
      );
    }),
    operationRoute(hostContractById["extension.deployment.disable"], (context) => {
      sendMutation(
        context,
        setDeploymentEnabled(context.state, { ...context.input.body, enabled: false }),
        context.input.query,
      );
    }),
    operationRoute(hostContractById["extension.deployment.delete"], (context) => {
      sendMutation(context, deleteDeployments(context.state, context.input.body), context.input.query);
    }),
    route("extension-open-local-path", "POST", "/extensions/open-local-path", async (context) => {
      const payload = record(await context.readJsonBody(context.request));
      const result = await openExtensionLocalPath(stringValue(payload.path));
      context.sendJson(context.response, result.ok ? 200 : 400, { ok: result.ok, result });
      return true;
    }),
  ];
}

function sendMutation(
  context: BridgeRouteContext,
  result: ExtensionActionResult,
  query: { includeSystem?: boolean },
): void {
  if (result.ok) {
    context.state.store.saveFrom(context.state.app);
    recreateBridgeApp(context.state);
  }
  context.sendJson(context.response, result.ok ? 200 : 400, {
    ok: result.ok,
    result,
    extensions: scanExtensionInventory(context.state, query),
  });
}
