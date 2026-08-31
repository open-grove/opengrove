import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "../core.js";
import {
  deleteDeployments,
  importSkillToLibrary,
  publishSkillToKernels,
  setDeploymentEnabled,
  unpublishSkillFromKernels,
} from "../extensions/manager.js";
import { scanExtensionInventory } from "../extensions/scanner.js";
import { BRIDGE_KERNEL_IDS } from "../server/bridge-types.js";
import type { BridgeKernelId, BridgeState } from "../server/bridge-types.js";

const toolSpec: ToolSpec = {
  id: "host.echo",
  title: "Host Echo",
  description: "Host tool used by extension manager harness.",
  activity: "local",
  risk: "read",
  input: { type: "json-schema", schema: { type: "object" } },
  permission: { mode: "allow", reason: "harness" },
};

function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opengrove-extension-manager-"));
  const workspaceRoot = join(tmp, "workspace");
  const dataRoot = join(tmp, "data");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });

  const overrides = Object.fromEntries(
    BRIDGE_KERNEL_IDS.map((kernelId) => [
      kernelId,
      {
        configHome: join(tmp, "kernels", kernelId),
        binaryPath: "/bin/echo",
      },
    ]),
  );

  const state = {
    app: {
      skills: {
        list: () => [
          {
            id: "skill.registered-guide",
            name: "registered-guide",
            title: "Registered Guide",
            description: "Registered skill used by extension manager harness.",
            source: "bundled",
            entry: join(tmp, "registered", "SKILL.md"),
            toolIds: [],
            allowedTools: ["host.echo"],
            tags: ["registered"],
          },
        ],
      },
      tools: {
        specs: () => [toolSpec],
      },
    },
    store: {
      kind: "json",
      path: join(dataRoot, "state.json"),
    },
    settings: {
      kernel: "claude-code",
      workspaceRoot,
      kernelPathOverrides: overrides,
    },
    kernel: "codex",
  } as unknown as BridgeState;

  const codexHome = overrides.codex!.configHome;
  const openclawHome = overrides.openclaw!.configHome;
  const claudeHome = overrides["claude-code"]!.configHome;
  const opencodeHome = overrides.opencode!.configHome;

  writeSkill(join(codexHome, "skills", "codex-origin"), "codex-origin", "Codex Origin");
  writeSkill(join(openclawHome, "skills", "claw-origin"), "claw-origin", "Claw Origin");
  writeSkill(join(tmp, "kernels", ".agents", "skills", "shared-agent"), "shared-agent", "Shared Agent");
  writeSkill(join(workspaceRoot, ".opencode", "skills", "opencode-project"), "opencode-project", "OpenCode Project");

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      "[mcp_servers.linear]",
      'command = "npx"',
      'args = ["-y", "linear-mcp"]',
      "",
      "[mcp_servers.linear.env]",
      'LINEAR_API_KEY = "secret"',
      "",
    ].join("\n"),
    "utf8",
  );

  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo hook" }],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const pluginDir = join(opencodeHome, "plugins", "sample-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        name: "sample-plugin",
        title: "Sample Plugin",
        description: "Harness plugin.",
        command: "node",
        args: ["server.js"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const firstInventory = scanExtensionInventory(state);
  assert.ok(
    firstInventory.deployments.some(
      (deployment) =>
        deployment.kind === "skill" &&
        deployment.kernelId === "codex" &&
        deployment.targetPath?.endsWith(join("skills", "codex-origin")),
    ),
    "codex user skills should be scanned from configured kernel path",
  );
  assert.ok(
    firstInventory.deployments.some(
      (deployment) =>
        deployment.kind === "skill" &&
        deployment.kernelId === "openclaw" &&
        deployment.targetPath?.endsWith(join("skills", "claw-origin")),
    ),
    "openclaw user skills should be scanned from configured kernel path",
  );
  assert.ok(
    firstInventory.deployments.some(
      (deployment) =>
        deployment.kind === "skill" &&
        deployment.kernelId === "opencode" &&
        deployment.scope === "project" &&
        deployment.targetPath?.endsWith(join(".opencode", "skills", "opencode-project")),
    ),
    "project skill roots should be scanned for kernels that expose project skills",
  );
  assert.ok(
    firstInventory.deployments.some((deployment) => deployment.kind === "mcp" && deployment.itemId === "mcp.linear"),
    "codex toml MCP server should be scanned",
  );
  assert.ok(
    firstInventory.deployments.some(
      (deployment) => deployment.kind === "hook" && deployment.kernelId === "claude-code",
    ),
    "claude hooks should be scanned",
  );
  assert.ok(
    firstInventory.deployments.some(
      (deployment) => deployment.kind === "plugin" && deployment.itemId === "plugin.sample-plugin",
    ),
    "plugin manifests should be scanned",
  );
  assert.ok(
    firstInventory.deployments.some(
      (deployment) => deployment.kind === "tool" && deployment.itemId === "tool.host.echo",
    ),
    "OpenGrove host tools should be represented in extension inventory",
  );
  assert.ok(
    firstInventory.items.some((item) => item.kind === "skill" && item.name === "registered-guide" && item.system),
    "registered bundled skills should be represented in extension inventory",
  );

  const importResult = importSkillToLibrary(state, {
    sourcePath: join(codexHome, "skills", "codex-origin"),
    replace: true,
  });
  assert.equal(importResult.ok, true);
  assert.ok(existsSync(join(dataRoot, "extensions", "skills", "codex-origin", "SKILL.md")));

  const publishResult = publishSkillToKernels(state, {
    librarySkillId: "codex-origin",
    targetKernelIds: ["codex", "openclaw"],
    scope: "user",
    replace: true,
  });
  assert.equal(publishResult.ok, true);
  assert.equal(publishResult.records.length, 2);
  assert.ok(existsSync(join(tmp, "kernels", ".agents", "skills", "codex-origin", "SKILL.md")));
  assert.ok(existsSync(join(openclawHome, "skills", "codex-origin", "SKILL.md")));

  const afterPublish = scanExtensionInventory(state);
  const openclawDeployment = requireDeployment(afterPublish, "skill", "openclaw", "skill.codex-origin");
  const disableSkill = setDeploymentEnabled(state, {
    deploymentIds: [openclawDeployment.id],
    enabled: false,
  });
  assert.equal(disableSkill.ok, true);
  assert.ok(existsSync(join(openclawHome, "skills", "codex-origin", "SKILL.md.disabled")));
  const enableSkill = setDeploymentEnabled(state, {
    deploymentIds: [openclawDeployment.id],
    enabled: true,
  });
  assert.equal(enableSkill.ok, true);
  assert.ok(existsSync(join(openclawHome, "skills", "codex-origin", "SKILL.md")));

  const mcpDeployment = requireDeployment(scanExtensionInventory(state), "mcp", "codex", "mcp.linear");
  const disableMcp = setDeploymentEnabled(state, {
    deploymentIds: [mcpDeployment.id],
    enabled: false,
  });
  assert.equal(disableMcp.ok, true);
  assert.ok(!readFileSync(join(codexHome, "config.toml"), "utf8").includes("[mcp_servers.linear]"));
  assert.equal(requireDeployment(scanExtensionInventory(state), "mcp", "codex", "mcp.linear").status, "disabled");
  const enableMcp = setDeploymentEnabled(state, {
    deploymentIds: [mcpDeployment.id],
    enabled: true,
  });
  assert.equal(enableMcp.ok, true);
  assert.ok(readFileSync(join(codexHome, "config.toml"), "utf8").includes("[mcp_servers.linear]"));

  const pluginDeployment = requireDeployment(
    scanExtensionInventory(state),
    "plugin",
    "opencode",
    "plugin.sample-plugin",
  );
  const disablePlugin = setDeploymentEnabled(state, {
    deploymentIds: [pluginDeployment.id],
    enabled: false,
  });
  assert.equal(disablePlugin.ok, true);
  assert.ok(existsSync(join(pluginDir, "plugin.json.disabled")));
  const enablePlugin = setDeploymentEnabled(state, {
    deploymentIds: [pluginDeployment.id],
    enabled: true,
  });
  assert.equal(enablePlugin.ok, true);
  assert.ok(existsSync(join(pluginDir, "plugin.json")));

  const unpublish = unpublishSkillFromKernels(state, {
    deploymentIds: [openclawDeployment.id],
  });
  assert.equal(unpublish.ok, true);
  assert.ok(!existsSync(join(openclawHome, "skills", "codex-origin")));

  const codexDeployment = requireDeployment(scanExtensionInventory(state), "skill", "codex", "skill.codex-origin");
  const deleteResult = deleteDeployments(state, {
    deploymentIds: [codexDeployment.id],
    forceExternal: false,
  });
  assert.equal(deleteResult.ok, true);
  assert.ok(!existsSync(join(tmp, "kernels", ".agents", "skills", "codex-origin")));
}

function writeSkill(root: string, name: string, title: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `title: ${title}`,
      `description: ${title} description.`,
      "allowed-tools:",
      "  - Bash",
      "shell:",
      "  - echo",
      "---",
      `# ${title}`,
      "",
      `${title} body.`,
    ].join("\n"),
    "utf8",
  );
}

function requireDeployment(
  inventory: ReturnType<typeof scanExtensionInventory>,
  kind: string,
  kernelId: BridgeKernelId,
  itemId: string,
) {
  const deployment = inventory.deployments.find(
    (candidate) => candidate.kind === kind && candidate.kernelId === kernelId && candidate.itemId === itemId,
  );
  assert.ok(deployment, `${kind} ${itemId} should be deployed for ${kernelId}`);
  return deployment;
}

main();
