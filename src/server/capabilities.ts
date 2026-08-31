import type { BridgeState } from "./bridge-types.js";

export type BridgeProfileId = "local" | "test";

export interface BridgeCapabilitiesSnapshot {
  profile: BridgeProfileId;
  auth: "bridge-token" | "session" | "test";
  multiUser: boolean;
  storage: "json" | "sqlite" | "memory";
  blobStorage: "filesystem" | "memory";
  kernelRuntime: "local-process" | "fake";
  workspaceScoped: boolean;
  approvals: boolean;
  api: {
    prefix: "/api";
    legacyPaths: boolean;
    streamFormat: "ndjson";
  };
  desktop: {
    directoryPicker: boolean;
    importFolderPicker: boolean;
    nativeKnowledgeRoots: boolean;
    installKernel: boolean;
  };
  features: {
    rooms: boolean;
    routines: boolean;
  };
}

export function getBridgeCapabilitiesSnapshot(state: BridgeState): BridgeCapabilitiesSnapshot {
  const testProfile = state.profile === "test";

  return {
    profile: state.profile,
    auth: testProfile ? "test" : "bridge-token",
    multiUser: false,
    storage: state.store.kind,
    blobStorage: testProfile ? "memory" : "filesystem",
    kernelRuntime: testProfile ? "fake" : "local-process",
    workspaceScoped: false,
    approvals: true,
    api: {
      prefix: "/api",
      legacyPaths: true,
      streamFormat: "ndjson",
    },
    desktop: {
      directoryPicker: process.platform === "darwin",
      importFolderPicker: process.platform === "darwin",
      nativeKnowledgeRoots: true,
      installKernel: true,
    },
    features: {
      rooms: true,
      routines: true,
    },
  };
}
