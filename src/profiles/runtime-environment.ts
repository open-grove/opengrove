import type { OpenGroveProfile } from "./profile.js";

export type HostRuntimePresetId = "local-single" | "web-single" | "test";
export type HostRuntimeAuthMode = "bridge-token" | "session";

export type HostRuntimeEnvironment = Readonly<{
  preset: HostRuntimePresetId;
  profile: OpenGroveProfile;
  tenancy: "single-principal";
  execution: "local-process" | "fake";
  workspace: "host-local" | "memory";
  stateStore: "json" | "sqlite" | "memory";
  blobStore: "filesystem" | "memory";
  auth: HostRuntimeAuthMode;
}>;

export interface ResolveHostRuntimeEnvironmentInput {
  readonly preset?: unknown;
  readonly profile: OpenGroveProfile;
  readonly authMode: HostRuntimeAuthMode;
}

const PRESETS: Record<HostRuntimePresetId, Omit<HostRuntimeEnvironment, "auth">> = {
  "local-single": {
    preset: "local-single",
    profile: "local",
    tenancy: "single-principal",
    execution: "local-process",
    workspace: "host-local",
    stateStore: "sqlite",
    blobStore: "filesystem",
  },
  "web-single": {
    preset: "web-single",
    profile: "local",
    tenancy: "single-principal",
    execution: "local-process",
    workspace: "host-local",
    stateStore: "sqlite",
    blobStore: "filesystem",
  },
  test: {
    preset: "test",
    profile: "test",
    tenancy: "single-principal",
    execution: "fake",
    workspace: "memory",
    stateStore: "memory",
    blobStore: "memory",
  },
};

export function resolveHostRuntimeEnvironment(input: ResolveHostRuntimeEnvironmentInput): HostRuntimeEnvironment {
  const presetId = input.preset ?? (input.profile === "test" ? "test" : "local-single");
  if (typeof presetId !== "string" || !(presetId in PRESETS)) {
    throw new Error(`Unknown Host runtime preset: ${String(presetId)}`);
  }
  const preset = PRESETS[presetId as HostRuntimePresetId];
  if (preset.profile !== input.profile) {
    throw new Error(`Host runtime preset ${preset.preset} requires profile ${preset.profile}.`);
  }
  if (preset.preset === "web-single" && input.authMode !== "session") {
    throw new Error("Host runtime preset web-single requires session authentication.");
  }
  return Object.freeze({ ...preset, auth: input.authMode });
}
