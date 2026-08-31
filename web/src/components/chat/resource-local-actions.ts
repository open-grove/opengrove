import { openMountedAppLocalFile as openMountedAppLocalFileBridge, postJson as postBridgeJson } from "../../bridge";
import type { ChatResourceRef } from "./resource-model";

export type ChatResourceLocalOpenTarget = "finder" | "system";

export interface ChatResourceLocalActionDependencies {
  postJson(path: string, payload: unknown): Promise<unknown>;
  openMountedAppLocalFile(
    appId: string,
    payload: { path: string; target: ChatResourceLocalOpenTarget },
  ): Promise<unknown>;
}

const defaultDependencies: ChatResourceLocalActionDependencies = {
  postJson: (path, payload) => postBridgeJson(path, payload),
  openMountedAppLocalFile: (appId, payload) => openMountedAppLocalFileBridge(appId, payload),
};

export async function openLocalChatResource(
  resource: ChatResourceRef,
  target: ChatResourceLocalOpenTarget,
  dependencies: ChatResourceLocalActionDependencies = defaultDependencies,
): Promise<boolean> {
  if (!resource.path) return false;

  if (resource.origin === "workspace") {
    await dependencies.postJson("/workspace/resource/open", { path: resource.path, target });
    return true;
  }
  if (resource.origin === "mounted-app" && resource.appId) {
    await dependencies.openMountedAppLocalFile(resource.appId, { path: resource.path, target });
    return true;
  }
  if (resource.origin === "local" && target === "finder") {
    await dependencies.postJson("/local-resource/reveal", { path: resource.path });
    return true;
  }
  return false;
}
