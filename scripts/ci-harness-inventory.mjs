export const harnessOwners = [
  "state-storage",
  "rooms-routines",
  "apps-knowledge",
  "app-lifecycle",
  "kernels-providers",
  "web-desktop",
  "release-contracts",
];

export const integrationSuites = [
  "critical",
  "server-inventory",
  "pm-routing",
  "clean-home",
  "media-streaming",
  "packed-runtime",
  "state-migrations",
];

// One canonical record per executable harness. `owner` assigns the Main shard;
// `suite` preserves PR integration baselines. `inputs` adds cross-owner affected
// paths (exact files or directory prefixes ending in /). Web inputs stay broad
// because these harnesses also consume shared components, styles and runtime code.
export const harnessInventory = [
  task("package-contents", "scripts/test-package-contents.mjs", "kernels-providers", {
    suite: "packed-runtime",
    build: true,
  }),
  task("app-create-route", "dist/tests/app-create-route-harness.js", "apps-knowledge"),
  task("app-pack-publish", "dist/tests/app-pack-publish-harness.js", "apps-knowledge"),
  task("claude-bedrock-env", "dist/tests/claude-bedrock-env-harness.js", "kernels-providers"),
  task("client-bootstrap", "dist/tests/client-bootstrap-harness.js", "state-storage"),
  task("diagnostic-bundle-server", "dist/tests/diagnostic-bundle-server-harness.js", "web-desktop"),
  task("extension-manager", "dist/tests/extension-manager-harness.js", "apps-knowledge"),
  task(
    "kernel-capability-contract-evidence",
    "dist/tests/kernel-capability-contract-evidence-harness.js",
    "kernels-providers",
  ),
  task("kernel-event-contract", "dist/tests/kernel-event-contract-harness.js", "kernels-providers"),
  task("kernel-login", "dist/tests/kernel-login-harness.js", "kernels-providers"),
  task("mcp-app", "dist/tests/mcp-app-harness.js", "apps-knowledge"),
  task("mcp-app-media-cache", "dist/tests/mcp-app-media-cache-harness.js", "apps-knowledge"),
  task("runtime-environment", "dist/tests/runtime-environment-harness.js", "kernels-providers"),
  task("withdrawal-route", "dist/tests/withdrawal-route-harness.js", "kernels-providers"),

  task("web-remote-agent-ui", "scripts/test-web-remote-agent-ui.mjs", "web-desktop"),
  task("web-mounted-app-group-deletion", "scripts/test-web-mounted-app-group-deletion.mjs", "apps-knowledge", {
    inputs: ["web/"],
  }),
  task("web-account-profile-storage", "scripts/test-web-account-profile-storage.mjs", "state-storage", {
    inputs: ["web/"],
  }),
  task("web-development-proxy", "scripts/test-web-development-proxy.mjs", "web-desktop"),
  task("safe-json", "dist/tests/safe-json-harness.js", "state-storage"),
  task("policy", "dist/tests/policy-harness.js", "state-storage"),
  task("language-preference", "dist/tests/language-preference-harness.js", "state-storage"),
  task("room-run-approval-timeout", "dist/tests/room-run-approval-timeout-harness.js", "rooms-routines"),
  task("room-run-scheduler", "dist/tests/room-run-scheduler-harness.js", "rooms-routines", { suite: "pm-routing" }),
  task("room-run-envelope", "dist/tests/room-run-envelope-harness.js", "rooms-routines", { suite: "pm-routing" }),
  task("room-user-reply", "dist/tests/room-user-reply-harness.js", "rooms-routines"),
  task("room-run-scoped-realtime", "dist/tests/room-run-scoped-realtime-harness.js", "rooms-routines", {
    suite: "pm-routing",
  }),
  task("state-file-lock", "dist/tests/state-file-lock-harness.js", "state-storage"),
  task("sqlite-state-store", "dist/tests/sqlite-state-store-harness.js", "state-storage"),
  task("storage-overview", "dist/tests/storage-overview-harness.js", "state-storage", { suite: "critical" }),
  task("storage-maintenance-gate", "dist/tests/storage-maintenance-gate-harness.js", "state-storage", {
    suite: "critical",
  }),
  task("legacy-knowledge-app-migration", "dist/tests/legacy-knowledge-app-migration-harness.js", "apps-knowledge"),
  task("skill", "dist/tests/skill-harness.js", "apps-knowledge"),
  task("product-default-employees", "dist/tests/product-default-employees-harness.js", "apps-knowledge"),
  task("kernel-knowledge", "dist/tests/kernel-knowledge-harness.js", "apps-knowledge"),
  task("knowledge-ledger-retention", "dist/tests/knowledge-ledger-retention-harness.js", "apps-knowledge"),
  task("knowledge-imported-folder-root", "dist/tests/knowledge-imported-folder-root-harness.js", "apps-knowledge"),
  task("native-skill-publisher", "dist/tests/native-skill-publisher-harness.js", "apps-knowledge"),
  task("app-runtime-env", "dist/tests/app-runtime-env-harness.js", "apps-knowledge"),
  task("app-cli-env", "dist/tests/app-cli-env-harness.js", "apps-knowledge"),
  task("app-readiness", "dist/tests/app-readiness-harness.js", "apps-knowledge"),
  task("routine-scheduler", "dist/tests/routine-scheduler-harness.js", "rooms-routines"),
  task("routine-routes", "dist/tests/routine-routes-harness.js", "rooms-routines"),
  task("routine-data-passing", "dist/tests/routine-data-passing-harness.js", "rooms-routines"),
  task("routine-flow-instance", "dist/tests/routine-flow-instance-harness.js", "rooms-routines"),
  task("routine-file-import", "dist/tests/routine-file-import-harness.js", "rooms-routines"),
  task("workflow-create-tool", "dist/tests/workflow-create-tool-harness.js", "rooms-routines"),
  task("workflow-activate-tool", "dist/tests/workflow-activate-tool-harness.js", "rooms-routines"),
  task("pm-agent-seed", "dist/tests/pm-agent-seed-harness.js", "rooms-routines", { suite: "pm-routing" }),
  task("room-delegation", "dist/tests/room-delegation-harness.js", "rooms-routines", { suite: "pm-routing" }),
  task("app-builder", "dist/tests/app-builder-harness.js", "apps-knowledge"),
  task("app-store", "dist/tests/app-store-harness.js", "apps-knowledge", { suite: "critical" }),
  task("kernel-command-path", "dist/tests/kernel-command-path-harness.js", "kernels-providers"),
  task("codex-app-server-client", "dist/tests/codex-app-server-client-harness.js", "kernels-providers"),
  task("codex-event-projector", "dist/tests/codex-event-projector-harness.js", "kernels-providers"),
  task("claude-code-runtime", "dist/tests/claude-code-runtime-harness.js", "kernels-providers"),
  task("generic-cli-runtime", "dist/tests/generic-cli-runtime-harness.js", "kernels-providers"),
  task("claude-code-cli-resolution", "dist/tests/claude-code-cli-resolution-harness.js", "kernels-providers"),
  task("claude-agent-sdk-runtime", "dist/tests/claude-agent-sdk-runtime-harness.js", "kernels-providers"),
  task("claude-models-cache", "dist/tests/claude-models-cache-harness.js", "kernels-providers"),
  task("pi-runtime", "dist/tests/pi-runtime-harness.js", "kernels-providers"),
  task("kernel-capability-evidence-generated", "scripts/generate-certified-kernel-evidence.mjs", "kernels-providers"),
  task("kernel-capability-source", "dist/tests/kernel-capability-source-harness.js", "kernels-providers"),
  task("kernel-capability-report", "dist/tests/kernel-capability-report-harness.js", "kernels-providers"),
  task("kernel-capability-requirements", "dist/tests/kernel-capability-requirements-harness.js", "kernels-providers"),
  task(
    "pi-native-tool-real-runtime-evidence",
    "dist/tests/pi-native-tool-real-runtime-evidence-harness.js",
    "kernels-providers",
  ),
  task("pi-story-seed-business-e2e", "dist/tests/pi-story-seed-business-e2e-harness.js", "kernels-providers"),
  task("kernel-capability-ui-policy", "scripts/test-kernel-capability-ui-policy.mjs", "kernels-providers", {
    inputs: ["web/"],
  }),
  task("hermes-runtime", "dist/tests/hermes-runtime-harness.js", "kernels-providers"),
  task("kernel-extension", "dist/tests/kernel-extension-harness.js", "kernels-providers"),
  task("acp-cli-runtime", "dist/tests/acp-cli-runtime-harness.js", "kernels-providers"),
  task("openclaw-gateway-runtime", "dist/tests/openclaw-gateway-runtime-harness.js", "kernels-providers"),
  task("agent-output-resolver", "dist/tests/agent-output-resolver-harness.js", "kernels-providers", {
    inputs: ["web/"],
  }),
  task("bridge-kernel-selection", "dist/tests/bridge-kernel-selection-harness.js", "kernels-providers", {
    suite: "critical",
  }),
  task("login-provider-choice", "dist/tests/login-provider-choice-harness.js", "kernels-providers"),
  task("client-activity-system-info", "dist/tests/client-activity-system-info.test.js", "kernels-providers"),
  task("ww-hosted-services", "dist/tests/ww-hosted-services-harness.js", "kernels-providers"),
  task("ww-auth", "dist/tests/ww-auth-harness.js", "kernels-providers"),
  task("app-update-routing", "dist/tests/app-update-routing-harness.js", "apps-knowledge", { suite: "critical" }),
  task("web-app-update-checks", "scripts/test-web-app-update-checks.mjs", "web-desktop", { suite: "critical" }),
  task("desktop-app-updates", "scripts/test-desktop-app-updates.mjs", "web-desktop", { suite: "critical" }),
  task("ww-provider-provisioning", "dist/tests/ww-provider-provisioning-harness.js", "kernels-providers"),
  task("ww-provider-reconciliation", "dist/tests/ww-provider-reconciliation-harness.js", "kernels-providers"),
  task("ww-provider-recovery", "dist/tests/ww-provider-recovery-harness.js", "kernels-providers"),
  task("mounted-app-seed-override", "dist/tests/mounted-app-seed-override-harness.js", "apps-knowledge"),
  task("mounted-app-member-management", "dist/tests/mounted-app-member-management-harness.js", "apps-knowledge"),
  task("local-unscoped-migration", "dist/tests/local-unscoped-migration-harness.js", "state-storage", {
    suite: "state-migrations",
  }),
  task(
    "session-local-mounted-app-members",
    "dist/tests/session-local-mounted-app-members-harness.js",
    "state-storage",
    {
      suite: "state-migrations",
    },
  ),
  task("ask-stream-actions", "dist/tests/ask-stream-actions-harness.js", "rooms-routines"),
  task("rooms-route-targeting", "dist/tests/rooms-route-targeting-harness.js", "rooms-routines", {
    suite: "pm-routing",
  }),
  task("room-run-history-mode", "dist/tests/room-run-history-mode-harness.js", "rooms-routines"),
  task("room-agent-runtime-fingerprint", "dist/tests/room-agent-runtime-fingerprint-harness.js", "rooms-routines"),
  task("host-operation-cli", "dist/tests/host-operation-cli-harness.js", "rooms-routines", { suite: "critical" }),
  task("a2a-local", "dist/tests/a2a-local-harness.js", "rooms-routines"),
  task("web-login-provider-choice", "scripts/test-web-login-provider-choice.mjs", "web-desktop"),
  task("web-composer-capability-gating", "scripts/test-web-composer-capability-gating.mjs", "web-desktop"),
  task("web-composer-interactions", "scripts/test-web-composer-interactions.mjs", "web-desktop"),
  task("web-markdown-flow", "scripts/test-web-markdown-flow.mjs", "web-desktop"),
  task("web-flow-live-todos", "scripts/test-web-flow-live-todos.mjs", "web-desktop"),
  task("web-radix-dialog", "scripts/test-web-radix-dialog.mjs", "web-desktop"),
  task("desktop-release-pipeline", "scripts/test-desktop-release-pipeline.mjs", "release-contracts"),
  task("bridge-bundle-experiment", "scripts/experiment-bridge-bundle.mjs", "web-desktop"),
  task("diagnostic-bundle", "dist/tests/diagnostic-bundle-harness.js", "web-desktop"),
  task("desktop-diagnostic-export", "scripts/test-desktop-diagnostic-export.mjs", "web-desktop"),
  task("desktop-bridge", "scripts/test-desktop-bridge.mjs", "web-desktop"),
  task("web-desktop-diagnostic-export", "scripts/test-web-desktop-diagnostic-export.mjs", "web-desktop"),
  task("auth-degraded-policy", "scripts/test-auth-degraded-policy.mjs", "web-desktop"),
  task("web-auth-ui", "scripts/test-web-auth-ui.mjs", "web-desktop"),
  task("web-team-auth", "scripts/test-web-team-auth.mjs", "web-desktop"),

  task("rooms-store", "dist/tests/rooms-store-harness.js", "rooms-routines", { suite: "critical" }),
  task("local-app-draft", "dist/tests/local-app-draft-harness.js", "app-lifecycle", { suite: "critical" }),
  task("app-program-activation-recovery", "dist/tests/app-program-activation-recovery-harness.js", "app-lifecycle", {
    suite: "critical",
  }),
  task("app-version-activation-journal", "dist/tests/app-version-activation-journal-harness.js", "app-lifecycle", {
    suite: "critical",
  }),
  task("app-version-startup-recovery", "dist/tests/app-version-startup-recovery-harness.js", "app-lifecycle", {
    suite: "critical",
  }),
  task("app-version-activation", "dist/tests/app-version-activation-harness.js", "app-lifecycle", {
    suite: "critical",
  }),
  task("app-store-version-registry", "dist/tests/app-store-version-registry-harness.js", "app-lifecycle", {
    suite: "critical",
  }),
  task("app-version-manager", "dist/tests/app-version-manager-harness.js", "app-lifecycle", { suite: "critical" }),
  task("app-version-state", "dist/tests/app-version-state-harness.js", "app-lifecycle", { suite: "critical" }),
  task("app-release-source-snapshot", "dist/tests/app-release-source-snapshot-harness.js", "app-lifecycle", {
    suite: "critical",
  }),
  task("app-release-journal-client", "dist/tests/app-release-journal-client-harness.js", "app-lifecycle", {
    suite: "critical",
  }),
  task("app-release-coordinator", "dist/tests/app-release-coordinator-harness.js", "app-lifecycle", {
    suite: "critical",
    platforms: ["darwin", "linux"],
  }),
  task("app-release-registry-migration", "dist/tests/app-release-registry-migration-harness.js", "app-lifecycle", {
    suite: "critical",
    platforms: ["darwin", "linux"],
  }),
  task("app-release-apply", "dist/tests/app-release-apply-harness.js", "app-lifecycle", {
    suite: "critical",
    platforms: ["darwin", "linux"],
  }),
  // Windows intentionally rejects recipes until native Job Object ownership is available.
  task("app-release-windows-build-boundary", "dist/tests/app-release-local-build.test.js", "app-lifecycle", {
    suite: "critical",
    platforms: ["win32"],
  }),
  task("release-cli", "dist/tests/release-cli-harness.js", "app-lifecycle", { suite: "critical" }),
  task("release-cli-real-bridge", "dist/tests/release-cli-real-bridge-harness.js", "app-lifecycle", {
    suite: "critical",
  }),
  task("web-app-store-publish-page", "scripts/test-web-app-store-publish-page.mjs", "app-lifecycle", {
    suite: "critical",
    inputs: ["web/"],
  }),
  task("web-app-release-recovery", "scripts/test-web-app-release-recovery.mjs", "app-lifecycle", {
    suite: "critical",
    inputs: ["web/"],
  }),
  task("web-app-version-management", "scripts/test-web-app-version-management.mjs", "app-lifecycle", {
    suite: "critical",
    inputs: ["web/"],
  }),
  task("packaged-inventory", "dist/tests/packaged-inventory-harness.js", "app-lifecycle", {
    suite: "server-inventory",
  }),
  task("extension-manager-server", "dist/tests/extension-manager-server-harness.js", "app-lifecycle", {
    suite: "server-inventory",
  }),
  task("room-run-envelope-clean-home", "dist/tests/room-run-envelope-harness.js", "rooms-routines", {
    suite: "clean-home",
    isolation: "clean-home",
  }),
  task("pm-agent-seed-clean-home", "dist/tests/pm-agent-seed-harness.js", "rooms-routines", {
    suite: "clean-home",
    isolation: "clean-home",
  }),
  task("packed-runtime", "scripts/test-packed-runtime.mjs", "kernels-providers", {
    suite: "packed-runtime",
    network: true,
  }),
  task("raw-file-range", "dist/tests/raw-file-range-harness.js", "web-desktop", { suite: "media-streaming" }),
];

// Shared native regressions are executable records, also used by developer aliases.
export const nativeTasks = [
  { id: "desktop-cleanup", path: "scripts/test-desktop-rebuildable-cleanup.mjs" },
  ...[
    [
      "windows-discovery",
      "--test",
      "dist/tests/codex-windows-discovery.test.js",
      "dist/tests/windows-discovery-cache.test.js",
      "dist/tests/windows-command-probe.test.js",
      "dist/tests/windows-system-terminal.test.js",
    ],
    ["windows-archive", "--test", "dist/tests/app-store-archive.test.js"],
    ["windows-state-lock", "scripts/test-desktop-state-lock-recovery.mjs"],
    ["windows-state-ownership", "scripts/test-state-ownership.mjs"],
    ["windows-bridge-supervisor", "scripts/test-bridge-supervisor-lifecycle.mjs"],
    ["windows-process-start", "scripts/test-process-started-at.mjs"],
  ].map(([id, path, ...args]) => ({ id, path, args, platforms: ["win32"] })),
].map((entry) => ({ ...entry, timeoutMs: 300_000 }));

export function nativePlatformTasks(platform) {
  const ids = new Set([
    "kernel-login",
    "state-file-lock",
    "sqlite-state-store",
    "desktop-bridge",
    "app-store",
    "app-version-activation",
  ]);
  return harnessTasksForPlatform(
    [
      ...nativeTasks,
      ...harnessInventory.filter((entry) => entry.suite && !entry.network),
      ...(platform === "win32" ? harnessInventory.filter((entry) => ids.has(entry.id)) : []),
    ],
    platform,
  ).filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index);
}

// Unknown inputs select every owner. Known boundaries also include declared cross-owner inputs.
export function affectedHarnesses(paths, includeIntegration) {
  const owners = new Set(paths.length ? [] : harnessOwners);
  for (const path of paths) {
    const direct = harnessInventory.find(
      (entry) => entry.path === path || entry.path.replace(/^dist\//u, "src/").replace(/\.js$/u, ".ts") === path,
    );
    if (direct) {
      owners.add(direct.owner);
      continue;
    }
    if (/^src\/(?:kernel|runtime)\//u.test(path) || /^docker\/agents\//u.test(path)) owners.add("kernels-providers");
    else if (/^src\/(?:skills|knowledge|packs)\//u.test(path)) owners.add("apps-knowledge");
    else if (/^src\/(?:rooms|routines)\//u.test(path) || /^src\/server\/(?:room-|routine-)/u.test(path))
      owners.add("rooms-routines");
    else if (/^src\/server\/app-/u.test(path) || path.startsWith("src/app-builder/")) {
      owners.add("app-lifecycle");
      owners.add("apps-knowledge");
    } else if (/^(?:web|desktop|extension)\//u.test(path) || /^scripts\/.*(?:web|desktop)/u.test(path))
      owners.add("web-desktop");
    else if (/^docs\/releases\//u.test(path) || path === "CHANGELOG.md" || /release/.test(path))
      owners.add("release-contracts");
    else for (const owner of harnessOwners) owners.add(owner);
  }
  return harnessInventory.filter(
    (entry) =>
      !entry.network &&
      (owners.has(entry.owner) ||
        (includeIntegration && entry.suite) ||
        entry.inputs?.some((input) =>
          paths.some((path) => path === input || (input.endsWith("/") && path.startsWith(input))),
        )),
  );
}

validateInventory(harnessInventory);

const deterministicInventory = harnessInventory.filter((task) => !task.network);

export const harnessGroups = {
  ...Object.fromEntries(
    integrationSuites.map((suite) => [suite, harnessInventory.filter((task) => task.suite === suite)]),
  ),
  integration: deterministicInventory.filter((task) => task.suite),
  ...Object.fromEntries(
    harnessOwners.map((owner) => [owner, deterministicInventory.filter((task) => task.owner === owner)]),
  ),
  full: deterministicInventory,
  network: harnessInventory.filter((task) => task.network),
};

function task(id, path, owner, options = {}) {
  return { id, path, owner, timeoutMs: 300_000, ...options };
}

export function harnessTasksForPlatform(tasks, platform) {
  return tasks.filter((task) => !task.platforms || task.platforms.includes(platform));
}

function validateInventory(inventory) {
  const ids = new Set();
  for (const entry of inventory) {
    if (ids.has(entry.id)) throw new Error(`Duplicate harness id: ${entry.id}`);
    ids.add(entry.id);
    if (!harnessOwners.includes(entry.owner)) throw new Error(`Unknown harness owner for ${entry.id}: ${entry.owner}`);
    if (
      entry.inputs &&
      (!Array.isArray(entry.inputs) ||
        !entry.inputs.length ||
        entry.inputs.some((input) => typeof input !== "string" || !input) ||
        new Set(entry.inputs).size !== entry.inputs.length)
    )
      throw new Error(`Invalid harness inputs for ${entry.id}`);
    if (entry.suite && !integrationSuites.includes(entry.suite)) {
      throw new Error(`Unknown integration suite for ${entry.id}: ${entry.suite}`);
    }
    if (entry.isolation && entry.isolation !== "clean-home") {
      throw new Error(`Unknown harness isolation for ${entry.id}: ${entry.isolation}`);
    }
    if (
      entry.platforms &&
      (!entry.platforms.length || entry.platforms.some((platform) => !["darwin", "linux", "win32"].includes(platform)))
    ) {
      throw new Error(`Invalid harness platforms for ${entry.id}`);
    }
  }
}
