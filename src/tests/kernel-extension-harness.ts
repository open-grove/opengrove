import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { collectKernelExtensionLayout } from "../extensions/kernel-roots.js";
import { HERMES_KERNEL_MANIFEST } from "../kernel/adapters/hermes.js";
import { discoverKimiKernel } from "../kernel/adapters/kimi.js";
import {
  normalizeOpenCodeModelId,
  openCodeConfigContentForAccessMode,
  OPENCODE_KERNEL_CONTRACT,
} from "../kernel/adapters/opencode.js";
import { discoverPiKernel } from "../kernel/adapters/pi.js";
import { discoverOpenClawKernel } from "../kernel/adapters/openclaw.js";
import { AcpSessionProjector } from "../runtime/projectors/acp.js";
import { kernelTransportDescriptor } from "../runtime/transports/types.js";
import { defaultKernelConfigHome, kernelPathEnv } from "../server/kernel-utils.js";

function main() {
  assert.equal(kernelTransportDescriptor("acp").structuredToolEvents, true);
  assert.equal(kernelTransportDescriptor("oneshot-cli").structuredToolEvents, false);

  let assistantText = "";
  const projector = new AcpSessionProjector({
    runId: "run-extension",
    kernelId: "opencode",
    onAssistantText(text) {
      assistantText += text;
    },
  });
  const events = [
    ...projector.project({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hidden" } }),
    ...projector.project({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "bash: pwd",
      rawInput: { command: "pwd" },
    }),
    ...projector.project({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: "/tmp",
    }),
    ...projector.project({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }),
    ...projector.project({ sessionUpdate: "usage_update", inputTokens: 4, outputTokens: 2, totalTokens: 6 }),
  ];

  assert.equal(assistantText, "done");
  assert.ok(events.some((event) => event.type === "tool.started" && event.toolId === "opencode.bash"));
  assert.ok(events.some((event) => event.type === "tool.finished" && event.toolId === "opencode.bash"));
  assert.ok(events.some((event) => event.type === "assistant.delta" && event.text === "done"));
  assert.ok(events.some((event) => event.type === "runtime.diagnostic" && event.name === "opencode.acp.usage"));
  assert.equal(
    events.some((event) => event.type === "assistant.delta" && event.text === "hidden"),
    false,
  );

  assert.equal(HERMES_KERNEL_MANIFEST.transport.primary, "stdio-jsonrpc");
  assert.equal(HERMES_KERNEL_MANIFEST.harness.fakeServer, "stdio-jsonrpc");
  assert.equal(HERMES_KERNEL_MANIFEST.rollout?.status, "implemented");

  assert.equal(OPENCODE_KERNEL_CONTRACT.diagnostics?.defaultModeId, "acp-bridge");
  const opencodeDefaultPermission = JSON.parse(openCodeConfigContentForAccessMode(undefined, "default")) as any;
  assert.equal(opencodeDefaultPermission.permission["*"], "ask");
  assert.equal(opencodeDefaultPermission.model, "opencode/big-pickle");
  assert.equal(opencodeDefaultPermission.small_model, "opencode/big-pickle");
  assert.equal(
    normalizeOpenCodeModelId("opencode-default", JSON.stringify(opencodeDefaultPermission)),
    "opencode/big-pickle",
  );
  assert.equal(normalizeOpenCodeModelId("gpt-5.4", JSON.stringify(opencodeDefaultPermission)), "opencode/big-pickle");
  const opencodeFullAccessPermission = JSON.parse(openCodeConfigContentForAccessMode(undefined, "full-access")) as any;
  assert.equal(opencodeFullAccessPermission.permission, "allow");
  const opencodeMergedConfig = JSON.parse(
    openCodeConfigContentForAccessMode(
      JSON.stringify({
        model: "opengrove-volc-coding-plan/glm-5.1",
        provider: { "opengrove-volc-coding-plan": { models: { "glm-5.1": {} } } },
        permission: "allow",
      }),
      "default",
    ),
  ) as any;
  assert.equal(opencodeMergedConfig.model, "opengrove-volc-coding-plan/glm-5.1");
  assert.ok(opencodeMergedConfig.provider["opengrove-volc-coding-plan"].models["glm-5.1"]);
  assert.equal(opencodeMergedConfig.permission["*"], "ask");
  assert.equal(
    normalizeOpenCodeModelId(
      "glm-5.1",
      JSON.stringify({
        model: "opengrove-volc-coding-plan/glm-5.1",
        provider: {
          "opengrove-volc-coding-plan": {
            models: {
              "glm-5.1": {},
            },
          },
        },
      }),
    ),
    "opengrove-volc-coding-plan/glm-5.1",
    "OpenCode ACP model switching needs provider/model ids, not bare provider model ids",
  );
  const kimiDiscovery = discoverKimiKernel();
  assert.equal(kimiDiscovery.title, "Kimi Code");
  assert.equal(kimiDiscovery.configHome, join(homedir(), ".kimi-code"));
  assert.deepEqual(kimiDiscovery.installActions?.[0]?.command, [
    "sh",
    "-c",
    "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
  ]);
  assert.equal(defaultKernelConfigHome("kimi"), join(homedir(), ".kimi-code"));
  assert.deepEqual(kernelPathEnv({ kernelPathOverrides: { kimi: { configHome: "/tmp/kimi-code-home" } } }, "kimi"), {
    KIMI_CODE_HOME: "/tmp/kimi-code-home",
  });
  const kimiProjectRoot = process.cwd();
  const kimiWorkspace = join(kimiProjectRoot, "synthetic-kimi-subdir");
  const kimiConfigHome = resolve("/tmp/opengrove-kimi-home");
  const kimiLayout = collectKernelExtensionLayout(
    {
      kernelPathOverrides: { kimi: { configHome: kimiConfigHome } },
      workspaceRoot: kimiWorkspace,
      mountedApps: [],
    },
    "kimi",
    kimiWorkspace,
  );
  const kimiRootPaths = new Set(kimiLayout.roots.map((root) => root.path));
  assert.ok(kimiRootPaths.has(join(kimiConfigHome, "skills")));
  assert.ok(kimiRootPaths.has(join(homedir(), ".agents", "skills")));
  assert.ok(kimiRootPaths.has(join(kimiProjectRoot, ".kimi-code", "skills")));
  assert.ok(kimiRootPaths.has(join(kimiProjectRoot, ".agents", "skills")));
  assert.ok(kimiRootPaths.has(join(kimiConfigHome, "mcp.json")));
  assert.ok(kimiRootPaths.has(join(kimiProjectRoot, ".mcp.json")));
  assert.ok(kimiRootPaths.has(join(kimiWorkspace, ".kimi-code", "mcp.json")));
  assert.ok(kimiRootPaths.has(join(kimiConfigHome, "config.toml")));
  assert.equal(kimiRootPaths.has(join(kimiConfigHome, "hooks.json")), false);
  const piDiscovery = discoverPiKernel();
  assert.equal(piDiscovery.title, "Pi");
  assert.equal(piDiscovery.configHome, join(homedir(), ".pi"));
  const openclawDiscovery = discoverOpenClawKernel();
  assert.equal(openclawDiscovery.title, "OpenClaw");
  assert.equal(openclawDiscovery.configHome, join(homedir(), ".openclaw"));
}

main();
