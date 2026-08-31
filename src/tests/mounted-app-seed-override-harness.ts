import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyEmployeeDefinitionRuntimeToScopedSeeds,
  createBridgeState,
  recreateBridgeApp,
  syncMountedAppSeedMember,
  syncProductDefaultSeedMembers,
} from "../server/bridge-state.js";
import { mountedAppDefaultEmployees } from "../server/bridge-mounted-app-employees.js";
import { productDefaultEmployees } from "../server/product-default-employees.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";
import { cloneMember, normalizeMember } from "../rooms/channel-normalize.js";
import { OPENGROVE_PM_MEMBER_ID, PM_AGENT_SKILL_NAME, pmAgentMemberId } from "../rooms/room-pm.js";
import { handleRoomMemberRoutes } from "../server/routes/rooms/member-routes.js";
import { normalizeMember as normalizeMemberRoute, normalizeMemberPatch } from "../server/routes/rooms/normalizers.js";
import { saveBridgeSettings } from "../server/bridge-settings-store.js";
import { CURRENT_EMPLOYEE_MODEL_MIGRATION_VERSION } from "../server/migrations/native-employee-model-v1.js";

// A mounted-app employee as the manifest declares it (the seed).
function seedMember(overrides: Partial<RoomChannelMember> = {}): RoomChannelMember {
  return normalizeMember({
    id: "member-app-short-drama-studio-analyst",
    name: "分析师",
    kernel: "opencode",
    model: "opencode/big-pickle",
    role: "只读数据与查询",
    color: "#0ea5e9",
    defaultSkillIds: ["fb-ads-report", "supply-query-readonly"],
    appId: "short-drama-studio",
    source: "local",
    ...overrides,
  });
}

// Product-default employees use the same persisted runtime override semantics
// as every other local Employee. A new system default must not silently reset
// an App Builder kernel/model that the user selected in Contacts.
{
  const seed = productDefaultEmployees();
  const appBuilderSeed = seed.find((member) => member.id === "app-builder");
  assert.ok(appBuilderSeed);
  const storedAppBuilder: RoomChannelMember = {
    ...appBuilderSeed,
    avatarDataUrl: "data:image/png;base64,logical-employee-avatar",
    kernel: "codex",
    model: "gpt-5.6",
    userOverrides: ["avatarDataUrl", "kernel", "model"],
  };
  const merged = syncProductDefaultSeedMembers(new Map([[storedAppBuilder.id, storedAppBuilder]]), seed);
  const appBuilder = merged.find((member) => member.id === "app-builder");
  assert.equal(appBuilder?.kernel, "codex", "saved App Builder kernel survives product re-seeding");
  assert.equal(appBuilder?.model, "gpt-5.6", "saved App Builder model survives product re-seeding");

  const scopedSeed: RoomChannelMember = {
    ...appBuilderSeed,
    id: "member-app-story-seed-app-builder",
    appId: "story-seed",
    workspaceRoot: "/tmp/story-seed",
    kernel: "claude-code",
    model: "claude-opus-default",
  };
  const [boundScopedSeed] = applyEmployeeDefinitionRuntimeToScopedSeeds([scopedSeed], merged);
  assert.equal(boundScopedSeed?.kernel, "codex", "scoped binding follows its logical Employee kernel");
  assert.equal(boundScopedSeed?.model, "gpt-5.6", "scoped binding follows its logical Employee model");
  assert.equal(
    boundScopedSeed?.avatarDataUrl,
    undefined,
    "scoped bindings must not duplicate the logical Employee upload payload",
  );
  const staleScopedOverride = syncMountedAppSeedMember(
    {
      ...scopedSeed,
      userOverrides: ["kernel", "model"],
    },
    boundScopedSeed!,
  );
  assert.equal(staleScopedOverride.kernel, "codex", "hidden scoped overrides cannot diverge from the logical Employee");
  assert.equal(staleScopedOverride.model, "gpt-5.6", "logical Employee model remains authoritative after restart");
}

// PM follows the same one-definition/many-scoped-bindings model as App Builder.
// A legacy App-scoped PM override migrates once to the global definition, while
// the scoped member id stays stable for existing rooms and history.
{
  const seed = productDefaultEmployees();
  const pmSeed = seed.find((member) => member.id === OPENGROVE_PM_MEMBER_ID);
  assert.ok(pmSeed, "OpenGrove should seed one global PM Employee definition");
  const legacyPm: RoomChannelMember = {
    ...pmSeed,
    id: pmAgentMemberId("legacy-app"),
    employeeDefinitionId: undefined,
    appId: "legacy-app",
    workspaceRoot: "/tmp/legacy-app",
    kernel: "codex",
    model: "gpt-5.6",
    avatarMode: "generated",
    avatarSeed: "legacy-pm-avatar",
    defaultSkillIds: [PM_AGENT_SKILL_NAME],
    userOverrides: ["kernel", "model", "avatarMode", "avatarSeed"],
  };
  const migrated = syncProductDefaultSeedMembers(new Map([[legacyPm.id, legacyPm]]), seed);
  const globalPm = migrated.find((member) => member.id === OPENGROVE_PM_MEMBER_ID);
  assert.equal(globalPm?.employeeDefinitionId, OPENGROVE_PM_MEMBER_ID);
  assert.equal(globalPm?.kernel, "codex", "legacy PM runtime override migrates to the global PM");
  assert.equal(globalPm?.model, "gpt-5.6");
  assert.equal(globalPm?.avatarSeed, "legacy-pm-avatar");

  const scopedPmSeed: RoomChannelMember = {
    ...pmSeed,
    id: legacyPm.id,
    appId: "legacy-app",
    workspaceRoot: "/tmp/legacy-app",
    kernel: "claude-code",
    model: "claude-opus-default",
  };
  const [boundPm] = applyEmployeeDefinitionRuntimeToScopedSeeds([scopedPmSeed], migrated);
  assert.equal(boundPm?.id, legacyPm.id, "the App-scoped PM id remains stable");
  assert.equal(boundPm?.employeeDefinitionId, OPENGROVE_PM_MEMBER_ID);
  assert.equal(boundPm?.kernel, "codex");
  assert.equal(boundPm?.model, "gpt-5.6");
  assert.equal(boundPm?.avatarSeed, "legacy-pm-avatar");
}

// Multiple legacy PMs intentionally migrate without prompting. The PM with the
// most explicitly overridden shared fields wins; a stable member-id ordering
// breaks ties so the same persisted state always produces the same global PM.
{
  const seed = productDefaultEmployees();
  const pmSeed = seed.find((member) => member.id === OPENGROVE_PM_MEMBER_ID);
  assert.ok(pmSeed);
  const fewerOverrides: RoomChannelMember = {
    ...pmSeed,
    id: pmAgentMemberId("alpha-app"),
    employeeDefinitionId: undefined,
    appId: "alpha-app",
    workspaceRoot: "/tmp/alpha-app",
    kernel: "codex",
    model: "gpt-5.6",
    userOverrides: ["kernel", "model"],
  };
  const moreOverrides: RoomChannelMember = {
    ...pmSeed,
    id: pmAgentMemberId("zeta-app"),
    employeeDefinitionId: undefined,
    appId: "zeta-app",
    workspaceRoot: "/tmp/zeta-app",
    kernel: "opencode",
    model: "opencode/big-pickle",
    accessMode: "full-access",
    reasoningEffort: "high",
    userOverrides: ["kernel", "model", "accessMode", "reasoningEffort"],
  };
  const migrated = syncProductDefaultSeedMembers(
    new Map([
      [fewerOverrides.id, fewerOverrides],
      [moreOverrides.id, moreOverrides],
    ]),
    seed,
  );
  const globalPm = migrated.find((member) => member.id === OPENGROVE_PM_MEMBER_ID);
  assert.equal(globalPm?.kernel, "opencode", "the PM with more explicit overrides wins");
  assert.equal(globalPm?.model, "opencode/big-pickle");
  assert.equal(globalPm?.accessMode, "full-access");
  assert.equal(globalPm?.reasoningEffort, "high");
}

{
  const seed = productDefaultEmployees();
  const pmSeed = seed.find((member) => member.id === OPENGROVE_PM_MEMBER_ID);
  assert.ok(pmSeed);
  const alphaPm: RoomChannelMember = {
    ...pmSeed,
    id: pmAgentMemberId("alpha-app"),
    employeeDefinitionId: undefined,
    appId: "alpha-app",
    workspaceRoot: "/tmp/alpha-app",
    kernel: "codex",
    model: "gpt-5.6",
    userOverrides: ["kernel", "model"],
  };
  const zetaPm: RoomChannelMember = {
    ...pmSeed,
    id: pmAgentMemberId("zeta-app"),
    employeeDefinitionId: undefined,
    appId: "zeta-app",
    workspaceRoot: "/tmp/zeta-app",
    kernel: "opencode",
    model: "opencode/big-pickle",
    userOverrides: ["kernel", "model"],
  };
  const migrated = syncProductDefaultSeedMembers(
    new Map([
      [zetaPm.id, zetaPm],
      [alphaPm.id, alphaPm],
    ]),
    seed,
  );
  const globalPm = migrated.find((member) => member.id === OPENGROVE_PM_MEMBER_ID);
  assert.equal(globalPm?.kernel, "codex", "equal override counts use stable member-id ordering");
  assert.equal(globalPm?.model, "gpt-5.6");
}

// 1) No user overrides → seed fully wins (manifest stays authoritative).
{
  const existing = seedMember({ kernel: "claude-code", model: "us.anthropic.claude-opus-4-8[1m]" });
  // existing has been re-seeded before but the user never edited it.
  const merged = syncMountedAppSeedMember(existing, seedMember());
  assert.equal(merged.kernel, "opencode", "without override, kernel follows manifest seed");
  assert.equal(merged.model, "opencode/big-pickle", "without override, model follows manifest seed");
}

// 2) User edited kernel/model → those survive re-seeding, role still follows manifest.
{
  const existing = seedMember({
    kernel: "claude-code",
    model: "us.anthropic.claude-opus-4-8[1m]",
    role: "STALE ROLE the user never set",
    userOverrides: ["kernel", "model"],
  });
  const seed = seedMember({ role: "FRESH manifest role with App instructions" });
  const merged = syncMountedAppSeedMember(existing, seed);
  assert.equal(merged.kernel, "claude-code", "edited kernel is preserved across seed sync");
  assert.equal(merged.model, "us.anthropic.claude-opus-4-8[1m]", "edited model is preserved across seed sync");
  assert.equal(
    merged.role,
    "FRESH manifest role with App instructions",
    "role is NOT protected and follows manifest upgrade",
  );
  assert.deepEqual(merged.userOverrides, ["kernel", "model"], "userOverrides carries forward");
}

// 3) manifestDefaults snapshot is refreshed from the current seed on every sync.
{
  const existing = seedMember({ kernel: "claude-code", userOverrides: ["kernel"] });
  const seed = seedMember({ model: "opencode/new-default" });
  const merged = syncMountedAppSeedMember(existing, seed);
  assert.equal(merged.manifestDefaults?.kernel, "opencode", "manifestDefaults.kernel reflects seed");
  assert.equal(
    merged.manifestDefaults?.model,
    "opencode/new-default",
    "manifestDefaults.model reflects the upgraded seed",
  );
  assert.deepEqual(merged.manifestDefaults?.defaultSkillIds, ["fb-ads-report", "supply-query-readonly"]);
}

// 4) defaultSkillIds override is honored.
{
  const existing = seedMember({ defaultSkillIds: ["only-my-skill"], userOverrides: ["defaultSkillIds"] });
  const merged = syncMountedAppSeedMember(existing, seedMember());
  assert.deepEqual(merged.defaultSkillIds, ["only-my-skill"], "edited defaultSkillIds preserved");
}

// Provider routing is user-owned local state, not an App seed default.
{
  const existing = seedMember({
    providerId: "ww",
    userOverrides: ["providerId"],
  });
  const merged = syncMountedAppSeedMember(existing, seedMember({ providerId: undefined }));
  assert.equal(merged.providerId, "ww", "App re-seeding preserves the user's local Provider choice");
  assert.deepEqual(merged.userOverrides, ["providerId"]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(merged.manifestDefaults ?? {}, "providerId"),
    false,
    "App manifest defaults never own Provider routing",
  );
}

// 4b) accessMode/reasoningEffort/contextTokenBudget follow the manifest seed when NOT overridden,
//     even if the existing member happens to carry different values.
{
  const existing = seedMember({ accessMode: "full-access", reasoningEffort: "xhigh", contextTokenBudget: 90_000 });
  const seed = seedMember({ accessMode: "auto-review", reasoningEffort: "low", contextTokenBudget: 150_000 });
  const merged = syncMountedAppSeedMember(existing, seed);
  assert.equal(merged.accessMode, "auto-review", "un-overridden accessMode follows manifest seed");
  assert.equal(merged.reasoningEffort, "low", "un-overridden reasoningEffort follows manifest seed");
  assert.equal(merged.contextTokenBudget, 150_000, "un-overridden contextTokenBudget follows manifest seed");
}

// 4c) accessMode/reasoningEffort/contextTokenBudget survive when the user DID override them.
{
  const existing = seedMember({
    accessMode: "full-access",
    reasoningEffort: "xhigh",
    contextTokenBudget: 90_000,
    userOverrides: ["accessMode", "reasoningEffort", "contextTokenBudget"],
  });
  const seed = seedMember({ accessMode: "auto-review", reasoningEffort: "low", contextTokenBudget: 150_000 });
  const merged = syncMountedAppSeedMember(existing, seed);
  assert.equal(merged.accessMode, "full-access", "overridden accessMode preserved");
  assert.equal(merged.reasoningEffort, "xhigh", "overridden reasoningEffort preserved");
  assert.equal(merged.contextTokenBudget, 90_000, "overridden contextTokenBudget preserved");
}

// 4d) Backcompat: older kernel edits accidentally saved the new kernel's default
//     avatar color as a color override. Treat that as a UI bug artifact and let
//     the manifest color win again.
{
  const existing = seedMember({
    kernel: "codex",
    model: "gpt-5.5",
    color: "#2563eb",
    userOverrides: ["kernel", "model", "color"],
  });
  const seed = seedMember({ color: "#be123c" });
  const merged = syncMountedAppSeedMember(existing, seed);
  assert.equal(merged.kernel, "codex", "edited kernel is still preserved");
  assert.equal(merged.model, "gpt-5.5", "edited model is still preserved");
  assert.equal(merged.color, "#be123c", "stale kernel-default color override is removed");
  assert.deepEqual(merged.userOverrides, ["kernel", "model"], "color override is pruned");
}

// 5) Round-trip: userOverrides/manifestDefaults survive normalize + clone (store load path).
{
  const member = seedMember({
    kernel: "claude-code",
    userOverrides: ["kernel", "model"],
    manifestDefaults: { kernel: "opencode", model: "opencode/big-pickle", defaultSkillIds: ["a", "b"] },
  });
  const reloaded = normalizeMember(JSON.parse(JSON.stringify(member)));
  assert.deepEqual(reloaded.userOverrides, ["kernel", "model"], "userOverrides survives normalize");
  assert.equal(reloaded.manifestDefaults?.kernel, "opencode", "manifestDefaults survives normalize");
  const cloned = cloneMember(reloaded);
  cloned.userOverrides?.push("color");
  assert.deepEqual(reloaded.userOverrides, ["kernel", "model"], "cloneMember deep-copies userOverrides");
  assert.notEqual(cloned.manifestDefaults, reloaded.manifestDefaults, "cloneMember deep-copies manifestDefaults");
}

// 6) Trust boundary: a client cannot forge userOverrides/manifestDefaults via the
//    route normalizers. Both are server-owned.
{
  const forgedPatch = normalizeMemberPatch({
    kernel: "claude-code",
    userOverrides: ["kernel", "model", "role"],
    manifestDefaults: { kernel: "fake-kernel", model: "fake-model" },
  });
  assert.equal("userOverrides" in forgedPatch, false, "PATCH normalizer drops client userOverrides");
  assert.equal("manifestDefaults" in forgedPatch, false, "PATCH normalizer drops client manifestDefaults");

  const forgedFull = normalizeMemberRoute({
    id: "member-app-x-y",
    userOverrides: ["kernel"],
    manifestDefaults: { kernel: "fake" },
  });
  assert.equal(forgedFull.userOverrides, undefined, "POST normalizer drops client userOverrides");
  assert.equal(forgedFull.manifestDefaults, undefined, "POST normalizer drops client manifestDefaults");
}

// 7) Clear semantics: sending null clears a field (key present in body → undefined value),
//    while omitting the key leaves it untouched.
{
  const cleared = normalizeMemberPatch({ reasoningEffort: null, contextTokenBudget: null });
  assert.equal("reasoningEffort" in cleared, true, "null key is present in the patch");
  assert.equal(cleared.reasoningEffort, undefined, "null normalizes to a cleared (undefined) value");
  assert.equal("contextTokenBudget" in cleared, true, "null budget key is present in the patch");
  assert.equal(cleared.contextTokenBudget, undefined, "null budget normalizes to a cleared (undefined) value");
  const clearedModel = normalizeMemberPatch({ model: "" }, "claude-code");
  assert.equal("model" in clearedModel, true, "an empty model remains an explicit patch key");
  assert.equal(clearedModel.model, undefined, "an empty model normalizes to a clear request");

  const untouched = normalizeMemberPatch({ model: "x" });
  assert.equal("reasoningEffort" in untouched, false, "omitted key stays out of the patch");

  assert.equal(
    normalizeMemberRoute({ id: "new-default", kernel: "claude-code", model: "native" }).model,
    "deepseek-v4-flash",
    "new Employee rows must normalize the legacy native sentinel to the product model",
  );
  assert.equal(
    normalizeMemberPatch({ model: "native" }, "claude-code").model,
    "deepseek-v4-flash",
    "Employee edits must not persist a new native model",
  );

  const invalidBudget = normalizeMemberPatch({ contextTokenBudget: -1 });
  assert.equal("contextTokenBudget" in invalidBudget, true, "an invalid supplied budget remains an explicit patch key");
  assert.equal(
    invalidBudget.contextTokenBudget,
    undefined,
    "invalid budgets safely normalize to unconfigured/follow mode",
  );
}

// 8) Clearing a reasoning/model override means "follow defaults"; it must not
//    create another override merely because the PATCH body contains the field.
{
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-clear-reasoning-override-"));
  const state = createBridgeState({ statePath: join(tempRoot, "state.json") });
  try {
    const memberId = "member-app-reasoning-default-worker";
    state.app.rooms.upsertMember({
      id: memberId,
      name: "Worker",
      kernel: "claude-code",
      model: "claude-code-default",
      reasoningEffort: "high",
      role: "Work",
      status: "idle",
      color: "#2563eb",
      lastActive: "now",
      appId: "reasoning-default",
      source: "local",
      userOverrides: ["kernel", "reasoningEffort"],
      manifestDefaults: {
        kernel: "claude-code",
        model: "claude-code-default",
        reasoningEffort: "low",
      },
    });
    const calls: Array<{ status: number; data: any }> = [];
    const handled = await handleRoomMemberRoutes({
      request: { method: "PATCH" } as any,
      response: {} as any,
      url: new URL(`http://opengrove.test/rooms/members/${encodeURIComponent(memberId)}`),
      state,
      sendJson: (_response, status, data) => calls.push({ status, data }),
      readJsonBody: async () => ({ kernel: "pi", reasoningEffort: null }),
    });
    assert.equal(handled, true);
    assert.equal(calls[0]?.status, 200);
    assert.equal(calls[0]?.data.member.kernel, "pi");
    assert.equal(calls[0]?.data.member.reasoningEffort, undefined);
    assert.deepEqual(
      calls[0]?.data.member.userOverrides,
      ["kernel"],
      "clearing reasoning while switching Kernels must restore inherited defaults instead of recording a user choice",
    );

    const modelMemberId = "member-app-model-default-worker";
    state.app.rooms.upsertMember({
      id: modelMemberId,
      name: "Model Worker",
      kernel: "claude-code",
      model: "deepseek-v4-pro",
      role: "Work",
      status: "idle",
      color: "#16a34a",
      lastActive: "now",
      appId: "model-default",
      source: "local",
      userOverrides: ["kernel", "model"],
      manifestDefaults: {
        kernel: "claude-code",
        model: "claude-opus-4-8",
      },
    });
    await handleRoomMemberRoutes({
      request: { method: "PATCH" } as any,
      response: {} as any,
      url: new URL(`http://opengrove.test/rooms/members/${encodeURIComponent(modelMemberId)}`),
      state,
      sendJson: (_response, status, data) => calls.push({ status, data }),
      readJsonBody: async () => ({ model: "" }),
    });
    assert.equal(calls[1]?.data.member.model, "claude-opus-4-8");
    assert.deepEqual(
      calls[1]?.data.member.userOverrides,
      ["kernel"],
      "clearing a model must restore the App default and remove the model override",
    );

    await handleRoomMemberRoutes({
      request: { method: "PATCH" } as any,
      response: {} as any,
      url: new URL(`http://opengrove.test/rooms/members/${encodeURIComponent(modelMemberId)}`),
      state,
      sendJson: (_response, status, data) => calls.push({ status, data }),
      readJsonBody: async () => ({ kernel: "codex", model: null }),
    });
    assert.equal(
      calls[2]?.data.member.model,
      "codex-default",
      "clearing a model while switching Kernels must follow the new Kernel default",
    );
    assert.deepEqual(calls[2]?.data.member.userOverrides, ["kernel"]);
  } finally {
    await state.store.close?.();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// 9) Mounted-App seeds without a declared Kernel/model use the concrete product
//    fallback instead of inheriting local Kernel config or a bootstrap sentinel.
{
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-mounted-app-defaults-"));
  try {
    const appRoot = join(tempRoot, "app");
    const workspaceRoot = join(appRoot, "workspace");
    const claudeHome = join(tempRoot, "claude-home");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: "us-west-2",
          ANTHROPIC_MODEL: "us.anthropic.claude-opus-4-8[1m]",
        },
        model: "us.anthropic.claude-opus-4-8[1m]",
      }),
    );
    writeFileSync(
      join(appRoot, "opengrove.app.json"),
      JSON.stringify({
        id: "runtime-default-test",
        title: "Runtime Default Test",
        workspace: { path: "workspace" },
        employees: [
          {
            id: "clipper",
            name: "Clipper",
            kernel: "claude-code",
            role: "Clipper role",
          },
          {
            id: "writer",
            name: "Writer",
            role: "Writer role",
          },
          {
            id: "analyst",
            name: "Analyst",
            kernel: "claude-code",
            model: "explicit-claude-model",
            reasoningEffort: "high",
            role: "Analyst role",
          },
          {
            id: "researcher",
            name: "Researcher",
            kernel: "codex",
            role: "Researcher role",
          },
        ],
      }),
    );

    const members = mountedAppDefaultEmployees({
      mountedApps: [{ id: "runtime-default-test", path: appRoot }],
      kernelPathOverrides: { "claude-code": { configHome: claudeHome } },
    } as any);

    const clipper = members.find((member) => member.id === "member-app-runtime-default-test-clipper");
    assert.equal(clipper?.kernel, "claude-code");
    assert.equal(clipper?.model, "deepseek-v4-flash", "Claude Code App defaults use the concrete product fallback");
    assert.equal(clipper?.reasoningEffort, "medium", "Claude Code app defaults use the employee reasoning default");

    const writer = members.find((member) => member.id === "member-app-runtime-default-test-writer");
    assert.equal(writer?.kernel, "claude-code", "an App Employee without a Kernel uses the product Kernel");
    assert.equal(writer?.model, "deepseek-v4-flash", "an App Employee without a model uses the product model");

    const analyst = members.find((member) => member.id === "member-app-runtime-default-test-analyst");
    assert.equal(analyst?.model, "explicit-claude-model", "explicit manifest model is preserved");
    assert.equal(analyst?.reasoningEffort, "high", "explicit manifest reasoning effort is preserved");

    const researcher = members.find((member) => member.id === "member-app-runtime-default-test-researcher");
    assert.equal(researcher?.kernel, "codex");
    assert.equal(
      researcher?.model,
      "codex-default",
      "an App Employee that explicitly selects another Kernel follows that Kernel default",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// 10) Apps without an English locale keep their canonical metadata verbatim.
{
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-mounted-app-english-fallback-"));
  try {
    const appRoot = join(tempRoot, "app");
    mkdirSync(join(appRoot, "workspace"), { recursive: true });
    writeFileSync(
      join(appRoot, "opengrove.app.json"),
      JSON.stringify({
        id: "legacy-workbench",
        defaultLocale: "zh-CN",
        title: "旧工作台",
        description: "只有中文描述",
        workspace: { path: "workspace" },
        employees: [
          {
            id: "reviewer",
            name: "审核员",
            kernel: "claude-code",
            providerId: "legacy-published-provider-must-be-ignored",
            role: "审核业务内容",
            publicDescription: "负责审核",
            publicSkills: ["审核"],
            inputSpec: "待审核内容",
            outputSpec: "审核结论",
          },
        ],
      }),
    );
    const members = mountedAppDefaultEmployees({
      languagePreference: "en",
      mountedApps: [{ id: "legacy-workbench", path: appRoot }],
    } as any);
    const reviewer = members.find((member) => member.id === "member-app-legacy-workbench-reviewer");
    assert.ok(reviewer);
    assert.equal(reviewer.displayName, undefined);
    assert.equal(reviewer.displayRole, undefined);
    assert.equal(reviewer.displayPublicDescription, undefined);
    assert.equal(reviewer.displayPublicSkills, undefined);
    assert.equal(reviewer.displayInputSpec, undefined);
    assert.equal(reviewer.displayOutputSpec, undefined);
    assert.equal(reviewer.name, "审核员", "canonical prompt-facing metadata remains unchanged");
    assert.match(reviewer.role, /审核业务内容/u, "canonical prompt-facing role remains unchanged");
    assert.equal(reviewer.publicDescription, "负责审核");
    assert.deepEqual(reviewer.publicSkills, ["审核"]);
    assert.equal(reviewer.inputSpec, "待审核内容");
    assert.equal(reviewer.outputSpec, "审核结论");
    assert.equal(reviewer.providerId, undefined, "legacy App Provider fields are ignored at the install boundary");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// 11) The explicit Contacts action restores every App-owned Employee field from
//     manifestDefaults, clears local override markers, and keeps App instructions.
{
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-restore-app-defaults-"));
  const state = createBridgeState({ statePath: join(tempRoot, "state.json") });
  try {
    const memberId = "member-app-story-seed-writer";
    state.app.rooms.upsertMember({
      id: memberId,
      name: "本机改名",
      kernel: "codex",
      model: "gpt-local",
      providerId: "ww",
      role: "本机职责\nApp instructions:\n保持 App 上下文",
      status: "idle",
      color: "#000000",
      lastActive: "now",
      appId: "story-seed",
      workspaceRoot: "/tmp/story-seed",
      contextTokenBudget: undefined,
      accessMode: "full-access",
      source: "local",
      userOverrides: ["name", "kernel", "model", "providerId", "contextTokenBudget", "accessMode", "color"],
      manifestDefaults: {
        name: "App 默认员工",
        role: "App 默认职责",
        kernel: "claude-code",
        model: "deepseek-v4-pro[1m]",
        contextTokenBudget: 200_000,
        accessMode: "auto-review",
        color: "#148a47",
      },
    });
    const calls: Array<{ status: number; data: any }> = [];
    const handled = await handleRoomMemberRoutes({
      request: { method: "POST" } as any,
      response: {} as any,
      url: new URL(`http://opengrove.test/rooms/members/${encodeURIComponent(memberId)}/restore-app-defaults`),
      state,
      sendJson: (_response, status, data) => calls.push({ status, data }),
      readJsonBody: async () => ({}),
    });
    assert.equal(handled, true);
    assert.equal(calls[0]?.status, 200);
    assert.equal(calls[0]?.data.member.name, "App 默认员工");
    assert.equal(calls[0]?.data.member.kernel, "claude-code");
    assert.equal(calls[0]?.data.member.model, "deepseek-v4-pro[1m]");
    assert.equal(calls[0]?.data.member.providerId, "ww", "restoring App defaults must preserve the local Provider");
    assert.equal(calls[0]?.data.member.contextTokenBudget, 200_000);
    assert.equal(calls[0]?.data.member.accessMode, "auto-review");
    assert.equal(calls[0]?.data.member.color, "#148a47");
    assert.match(calls[0]?.data.member.role, /^App 默认职责/);
    assert.match(
      calls[0]?.data.member.role,
      /App instructions:/,
      "restoring the public role must keep App context attached",
    );
    assert.deepEqual(calls[0]?.data.member.userOverrides, ["providerId"]);
  } finally {
    await state.store.close?.();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// 12) Uninstall deactivates an App PM projection without deleting its stable
// identity or history; reinstall reactivates that same projection and repairs
// the App group without ever inserting global PM.
{
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-uninstalled-pm-migration-"));
  const appId = "removed-custom-pm-app";
  const legacyPmId = pmAgentMemberId(appId);
  const statePath = join(tempRoot, "state.json");
  const databasePath = join(tempRoot, "state.sqlite");
  try {
    writeFileSync(
      join(tempRoot, "bridge-settings.json"),
      JSON.stringify({
        kernel: "claude-code",
        mountedApps: [],
        uninstalledStoreAppIds: [appId],
      }),
    );
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 9,
        savedAt: "2026-07-28T00:00:00.000Z",
        rooms: {
          version: 1,
          currentEventSeq: 1,
          rooms: [
            {
              id: `app-room--${appId}--group--default`,
              kind: "group",
              title: "Removed custom PM group",
              badge: "R",
              memberIds: [legacyPmId],
              adminMemberIds: [legacyPmId],
              updatedAt: "2026-07-28T00:00:00.000Z",
              unread: 0,
            },
          ],
          members: [
            {
              id: legacyPmId,
              appId,
              name: "Customized legacy PM",
              kernel: "codex",
              model: "gpt-5.6",
              role: "legacy project manager",
              status: "idle",
              color: "#2563eb",
              lastActive: "在线",
              defaultSkillIds: [PM_AGENT_SKILL_NAME],
              userOverrides: ["kernel", "model"],
              source: "local",
            },
          ],
          messages: [],
          events: [
            {
              eventSeq: 1,
              type: "room.member.added",
              roomId: "",
              memberId: legacyPmId,
              createdAt: "2026-07-28T00:00:00.000Z",
              payload: { member: { id: legacyPmId, appId } },
            },
          ],
          deletedMemberIds: [legacyPmId],
        },
      }),
    );

    const migrated = createBridgeState({ statePath });
    try {
      const globalPm = migrated.app.rooms.listMembers().find((member) => member.id === OPENGROVE_PM_MEMBER_ID);
      assert.equal(globalPm?.kernel, "codex", "legacy projection overrides still migrate once to global PM");
      assert.equal(globalPm?.model, "gpt-5.6");
      const inactiveProjection = migrated.app.rooms.listMembers().find((member) => member.id === legacyPmId);
      assert.ok(inactiveProjection, "uninstall keeps the stable App PM projection");
      assert.equal(inactiveProjection.disabled, true);
      assert.equal(inactiveProjection.status, "offline");
      assert.equal(inactiveProjection.lastActive, "manifest removed");
      const inactiveGroup = migrated.app.rooms.getRoom(`app-room--${appId}--group--default`);
      assert.deepEqual(inactiveGroup?.memberIds, [legacyPmId]);
      assert.deepEqual(inactiveGroup?.adminMemberIds, [legacyPmId]);
      assert.equal(inactiveGroup?.memberIds.includes(OPENGROVE_PM_MEMBER_ID), false);
      assert.equal(existsSync(`${databasePath}.before-app-pm-purge.json`), false);

      const appRoot = join(tempRoot, "removed-custom-pm-app");
      mkdirSync(join(appRoot, "workspace"), { recursive: true });
      writeFileSync(
        join(appRoot, "opengrove.app.json"),
        JSON.stringify({
          id: appId,
          title: "Restored custom PM App",
          workspace: { path: "workspace" },
          employees: [
            {
              id: "writer",
              name: "Writer",
              kernel: "codex",
              model: "gpt-5.6",
              role: "writer",
            },
          ],
        }),
      );
      migrated.settings.mountedApps = [{ id: appId, path: appRoot, enabled: true }];
      migrated.settings.uninstalledStoreAppIds = [];
      recreateBridgeApp(migrated);

      const reactivatedProjection = migrated.app.rooms.listMembers().find((member) => member.id === legacyPmId);
      assert.ok(reactivatedProjection, "reinstall reuses the exact App PM member id");
      assert.equal(reactivatedProjection.disabled, false);
      assert.equal(reactivatedProjection.employeeDefinitionId, OPENGROVE_PM_MEMBER_ID);
      const repairedGroup = migrated.app.rooms.getRoom(`app-room--${appId}--group--default`);
      assert.equal(repairedGroup?.memberIds.includes(OPENGROVE_PM_MEMBER_ID), false);
      assert.equal(repairedGroup?.memberIds.includes(legacyPmId), true);
      assert.equal(repairedGroup?.memberIds.includes(`member-app-${appId}-writer`), true);
      assert.deepEqual(repairedGroup?.adminMemberIds, [legacyPmId]);
    } finally {
      await migrated.store.close?.();
    }

    const database = new DatabaseSync(databasePath);
    try {
      const staleEvents = database
        .prepare(`
        SELECT COUNT(*) AS count FROM state_records
        WHERE collection = 'room_events' AND payload LIKE ?
      `)
        .get(`%${legacyPmId}%`) as { count: number };
      assert.ok(staleEvents.count > 0, "App PM history must survive uninstall and reinstall");
    } finally {
      database.close();
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// 13) The legacy native-model transform runs once behind a persisted version,
//     backs up the pre-migration ledger, and removes the retired model override.
{
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-native-employee-model-migration-"));
  const statePath = join(tempRoot, "state.sqlite");
  try {
    const legacy = createBridgeState({ statePath });
    legacy.app.rooms.upsertMember({
      id: "legacy-explicit-native",
      name: "Legacy Explicit Native",
      kernel: "codex",
      model: "native",
      role: "testing",
      status: "idle",
      color: "blue",
      lastActive: "configured",
      userOverrides: ["kernel", "model"],
      source: "local",
    });
    legacy.store.saveFrom(legacy.app);
    legacy.settings.employeeModelMigrationVersion = 0;
    saveBridgeSettings(legacy);
    await legacy.store.close?.();

    const migrated = createBridgeState({ statePath });
    try {
      const member = migrated.app.rooms.listMembers().find((candidate) => candidate.id === "legacy-explicit-native");
      assert.equal(member?.model, "codex-default");
      assert.deepEqual(member?.userOverrides, ["kernel"]);
      assert.equal(migrated.settings.employeeModelMigrationVersion, CURRENT_EMPLOYEE_MODEL_MIGRATION_VERSION);
      assert.equal(
        existsSync(`${statePath}.before-native-employee-model-v1.json`),
        true,
        "a persisted Employee rewrite must retain the pre-migration ledger",
      );
    } finally {
      await migrated.store.close?.();
    }

    const restarted = createBridgeState({ statePath });
    try {
      const member = restarted.app.rooms.listMembers().find((candidate) => candidate.id === "legacy-explicit-native");
      assert.equal(member?.model, "codex-default");
      assert.deepEqual(member?.userOverrides, ["kernel"]);
      assert.equal(
        restarted.settings.employeeModelMigrationVersion,
        CURRENT_EMPLOYEE_MODEL_MIGRATION_VERSION,
        "the completed migration must not be scheduled again",
      );
    } finally {
      await restarted.store.close?.();
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log("mounted-app-seed-override-harness ok");
