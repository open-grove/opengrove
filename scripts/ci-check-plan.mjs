import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyCiChanges } from "./ci-change-scope.mjs";
import { harnessOwners } from "./ci-harness-inventory.mjs";

export function createCiCheckPlan(event, paths) {
  if (!["pull_request", "merge_group", "push", "workflow_dispatch"].includes(event)) {
    throw new Error(`Unsupported CI event: ${event}`);
  }
  const scope = classifyCiChanges(event, paths);
  if (scope.docsOnly) {
    return { checks: [{ id: "docs", command: "npm run check:doc-refs" }], platforms: [], packages: [] };
  }
  const checks = [];
  const add = (id, command, enabled) => {
    if (enabled) checks.push({ id, command });
  };
  for (const [id, command, enabled] of [
    ["repository", "check:static:base", scope.base],
    ["server", "check:static:server", scope.server],
    ["web", "check:web", scope.web],
    ["desktop", "check:desktop", scope.desktop],
    ["release", "check:static:release", scope.release],
    ["unit", "test:unit", scope.unit],
    ["web-package", "test:pack:web", scope.webPackaging],
    ["browser-ui", "test:ui", scope.browserUi],
  ])
    add(id, `npm run ${command}`, enabled);

  const main = event === "push" || event === "workflow_dispatch";
  if (main) {
    for (const owner of harnessOwners) add(`harness-${owner}`, `npm run test:harness:${owner}`, true);
  } else {
    add("integration", "npm run test:integration", scope.integration);
    add("kernel", "npm run test:capabilities", scope.kernel);
    add("release-contracts", "npm run test:harness:release-contracts", scope.release);
  }
  add("desktop-protocol", "xvfb-run -a npm run test:desktop-protocol-proxy-electron", scope.desktop);
  const native = scope.server || scope.desktop || scope.kernel || scope.windowsMediaCleanup || scope.windowsAppStore;
  const platforms = native
    ? [
        { platform: "win32", runner: "windows-latest" },
        { platform: "darwin", runner: "macos-latest" },
      ]
    : [];
  const packages =
    native || scope.web || scope.webPackaging
      ? [
          { target: "windows-x64", runner: "windows-latest" },
          { target: "mac-arm64", runner: "macos-latest" },
        ]
      : [];
  return { checks, platforms, packages };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [event, ...paths] = process.argv.slice(2);
  const plan = createCiCheckPlan(event, paths);
  const output = Object.entries(plan)
    .map(([name, entries]) => `${name}=${JSON.stringify({ include: entries })}\nhas_${name}=${entries.length > 0}`)
    .join("\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## CI execution plan\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`,
    );
  }
  console.log(output);
}
