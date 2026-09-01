import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAppStoreEmployeeDefaults } from "../app-builder/manifest.js";
import {
  KERNEL_CAPABILITY_REQUIREMENTS_MIN_HOST_RELEASE,
  evaluateKernelCapabilityRequirements,
  inspectRequiredKernelCapabilities,
  normalizeRequiredKernelCapabilities,
} from "../kernel/capabilities/requirements.js";
import { buildKnownKernelCapabilityReport } from "../kernel/capabilities/report-for-kernel.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";
import { normalizeMember } from "../rooms/channel-normalize.js";
import {
  assertRoomTargetKernelCapabilities,
  roomKernelCapabilityErrorMessage,
  RoomKernelCapabilityError,
} from "../server/room-runs/execution-state.js";
import { mountedAppDefaultEmployees } from "../server/bridge-mounted-app-employees.js";
import { defaultBridgeSettings } from "../server/bridge-settings-store.js";
import { mountedAppReleaseManifest, normalizeReleaseEmployee } from "../server/app-release.js";

assert.deepEqual(normalizeRequiredKernelCapabilities(["tools.nativeTool"]), ["tools.nativeTool"]);
assert.deepEqual(inspectRequiredKernelCapabilities(["tools.nativeTool", "future.capability"]).invalid, [
  "1:unknown:future.capability",
]);
assert.deepEqual(inspectRequiredKernelCapabilities(["tools.nativeTool", "tools.nativeTool"]).invalid, [
  "1:duplicate:tools.nativeTool",
]);
assert.deepEqual(inspectRequiredKernelCapabilities(["tools.nativeTool", 7]).invalid, ["1:not_a_string"]);

const piCapabilityReport = buildKnownKernelCapabilityReport("pi", undefined, {
  hostVersion: "0.6.6",
  kernelVersion: "0.83.0",
  runtimeMode: "sdk",
});
const piResult = evaluateKernelCapabilityRequirements("pi", ["tools.nativeTool"], piCapabilityReport);
assert.equal(piResult.ok, true, "fresh Pi native-tool evidence must satisfy the requirement");

const invalidResult = evaluateKernelCapabilityRequirements(
  "pi",
  ["tools.nativeTool", "future.capability"],
  piCapabilityReport,
);
assert.equal(invalidResult.ok, false, "unknown required capabilities must fail closed");
assert.deepEqual(invalidResult.invalid, ["1:unknown:future.capability"]);

const member = roomMember({ kernel: "pi", requiredKernelCapabilities: ["tools.nativeTool"] });
assert.doesNotThrow(() => assertRoomTargetKernelCapabilities(member, piCapabilityReport));
assert.deepEqual(normalizeMember(member).requiredKernelCapabilities, ["tools.nativeTool"]);

assert.throws(
  () =>
    assertRoomTargetKernelCapabilities(
      roomMember({ kernel: "hermes", requiredKernelCapabilities: ["tools.hostTool"] }),
      buildKnownKernelCapabilityReport("hermes"),
    ),
  RoomKernelCapabilityError,
);
const missingCapabilityError = new RoomKernelCapabilityError({
  kernel: "hermes",
  required: ["tools.hostTool"],
  missing: ["tools.hostTool"],
});
assert.match(roomKernelCapabilityErrorMessage(missingCapabilityError, "zh-CN") ?? "", /尚未证明.*tools\.hostTool/);
assert.match(roomKernelCapabilityErrorMessage(missingCapabilityError, "en") ?? "", /has not proven.*tools\.hostTool/);

const manifestIssues = validateAppStoreEmployeeDefaults([
  {
    memberId: "member-app-demo-writer",
    name: "Writer",
    kernel: "pi",
    model: "pi-default",
    requiredKernelCapabilities: ["tools.nativeTool", "future.capability"],
  },
]);
assert.equal(manifestIssues.length, 1);
assert.match(manifestIssues[0] ?? "", /^0\.requiredKernelCapabilities\.1:/);
assert.match(
  validateAppStoreEmployeeDefaults([
    {
      memberId: "duplicate-capability-worker",
      name: "Duplicate capability worker",
      kernel: "pi",
      model: "pi-default",
      requiredKernelCapabilities: ["tools.nativeTool", "tools.nativeTool"],
    },
  ])[0] ?? "",
  /^0\.requiredKernelCapabilities\.1: duplicate capability:/,
);

const releaseEmployee = normalizeReleaseEmployee({
  memberId: "member-app-demo-writer",
  name: "Writer",
  role: "Writes files",
  kernel: "pi",
  model: "pi-default",
  color: "#2563eb",
  requiredKernelCapabilities: ["tools.nativeTool", "tools.hostTool"],
});
assert.deepEqual(releaseEmployee.requiredKernelCapabilities, ["tools.nativeTool", "tools.hostTool"]);
const releaseManifest = mountedAppReleaseManifest(
  { id: "demo", title: "Demo", store: {} },
  {
    identity: { appId: "demo", source: "mounted", appRoot: "/tmp/demo", workspaceRoot: "/tmp/demo/workspace" },
    app: { title: "Demo", description: "" },
    version: "0.1.0",
    releaseNotes: "requirements",
    visibility: "restricted",
    minHostReleaseNumber: KERNEL_CAPABILITY_REQUIREMENTS_MIN_HOST_RELEASE,
    employees: [releaseEmployee],
    checks: [],
  },
);
assert.equal(releaseManifest.store?.minHostReleaseNumber, KERNEL_CAPABILITY_REQUIREMENTS_MIN_HOST_RELEASE);
assert.deepEqual(releaseManifest.store?.employeeDefaults?.[0]?.requiredKernelCapabilities, [
  "tools.nativeTool",
  "tools.hostTool",
]);

const appRoot = mkdtempSync(join(tmpdir(), "opengrove-capability-requirements-app-"));
try {
  mkdirSync(join(appRoot, "workspace"));
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "capability-app",
      title: "Capability App",
      workspace: { path: "workspace" },
      disablePmAgent: true,
      employees: [
        {
          id: "writer",
          name: "Writer",
          kernel: "pi",
          requiredKernelCapabilities: ["tools.nativeTool", "tools.hostTool"],
        },
      ],
    }),
  );
  const mounted = mountedAppDefaultEmployees({
    ...defaultBridgeSettings(),
    mountedApps: [{ id: "capability-app", path: appRoot, enabled: true }],
  });
  assert.deepEqual(mounted[0]?.requiredKernelCapabilities, ["tools.nativeTool", "tools.hostTool"]);
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

console.log("kernel capability requirements harness passed");

function roomMember(overrides: Partial<RoomChannelMember> = {}): RoomChannelMember {
  return {
    id: "member-app-demo-writer",
    name: "Writer",
    kernel: "pi",
    model: "pi-default",
    role: "Writes files",
    status: "idle",
    color: "#2563eb",
    lastActive: "idle",
    ...overrides,
  };
}
