import { AsyncLocalStorage } from "node:async_hooks";
import type { PolicyRule } from "../core.js";
import type { BrowserPageSnapshot } from "../environment/browser-adapter.js";
import type { ComputerStateSnapshot } from "../environment/computer-adapter.js";
import type { BridgeWwRuntimeAuth } from "./ww-runtime-auth.js";

export interface BridgeTurnContext {
  threadId: string;
  model: string;
  snapshot: BrowserPageSnapshot;
  computerSnapshot: ComputerStateSnapshot;
  policyOverrides: PolicyRule[];
  wwAuth?: BridgeWwRuntimeAuth;
}

const bridgeTurnContext = new AsyncLocalStorage<BridgeTurnContext>();

export function runWithBridgeTurnContext<T>(context: BridgeTurnContext, callback: () => Promise<T>): Promise<T> {
  return bridgeTurnContext.run(context, callback);
}

export function getBridgeTurnContext(): BridgeTurnContext | undefined {
  return bridgeTurnContext.getStore();
}
