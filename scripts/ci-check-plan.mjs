import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyCiChanges, isDocumentationOnlyPath } from "./ci-change-scope.mjs";
import { harnessOwners, harnessGroups, affectedHarnesses } from "./ci-harness-inventory.mjs";

export function createCiCheckPlan(event, paths) {
  if (!["pull_request", "merge_group", "push", "workflow_dispatch"].includes(event)) {
    throw new Error(`Unsupported CI event: ${event}`);
  }
  const scope = classifyCiChanges(event, paths);
  if (scope.docsOnly) {
    return {
      checks: [{ id: "docs", command: "npm run check:doc-refs", browser: false, preparation: "node" }],
      platforms: [],
      packages: [],
    };
  }
  const checks = [];
  const add = (id, command, enabled) => {
    if (enabled)
      checks.push({
        id,
        command,
        preparation: id === "server" ? "server" : "dependencies",
        browser: [
          "integration",
          "browser-ui",
          "desktop-protocol",
          "harness-app-lifecycle",
          "harness-web-desktop",
        ].includes(id),
      });
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

  const addHarnesses = (id, tasks) => {
    if (!tasks.length) return;
    checks.push({
      id,
      command: `node scripts/run-built-harnesses.mjs --tasks ${tasks.map((task) => task.id).join(",")}`,
      tasks: tasks.map((task) => task.id),
      preparation: tasks.some((task) => task.build || task.path.startsWith("dist/")) ? "server" : "dependencies",
      browser: tasks.some((task) => ["app-lifecycle", "web-desktop"].includes(task.owner)),
    });
  };
  const main = event === "push" || event === "workflow_dispatch";
  if (main) {
    for (const owner of harnessOwners) addHarnesses(`harness-${owner}`, harnessGroups[owner]);
  } else if (scope.integration || scope.kernel || scope.web || scope.desktop || scope.release) {
    addHarnesses(
      "integration",
      affectedHarnesses(
        paths.filter((path) => !isDocumentationOnlyPath(path)),
        scope.integration,
      ),
    );
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
