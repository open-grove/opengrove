import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentRuntime, SkillManifest } from "../core.js";
import { APP_CONFIG_DIR } from "../identity.js";
import { createClaudeCodeKernelAdapter } from "../kernel/adapters/claude-code.js";
import { createCodexKernelAdapter } from "../kernel/adapters/codex.js";
import { createHermesKernelAdapter } from "../kernel/adapters/hermes.js";
import { PI_KERNEL_CONTRACT } from "../kernel/adapters/pi.js";
import { KIMI_KERNEL_CONTRACT, KimiKernelAdapter } from "../kernel/adapters/kimi.js";
import { OPENCODE_KERNEL_CONTRACT, OpenCodeKernelAdapter } from "../kernel/adapters/opencode.js";
import { createRuntimeKernelAdapter } from "../kernel/adapter.js";
import type { KernelAdapter, KernelCapabilities } from "../kernel/types.js";
import { publishNativeSkills } from "../skills/native-publisher.js";
import { writeFakeHermesGateway } from "./harnesses/fake-hermes-gateway.js";

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-native-skill-"));
  const projectSkillDir = join(cwd, APP_CONFIG_DIR, "skills", "native-demo");
  mkdirSync(projectSkillDir, { recursive: true });
  writeFileSync(
    join(projectSkillDir, "SKILL.md"),
    [
      "---",
      "title: Native Demo",
      "description: Native demo skill for publisher verification.",
      "when_to_use: When validating native skill publication.",
      "user-invocable: true",
      "---",
      "# Native Demo",
      "",
      "Native marker: SHOULD_NOT_BE_HOST_INJECTED",
    ].join("\n"),
    "utf8",
  );

  const kernels: Array<{ kernel: KernelAdapter; target: string }> = [
    {
      kernel: createCodexKernelAdapter({ command: "/bin/echo", cwd }),
      target: join(cwd, ".codex", "skills", "native-demo", "SKILL.md"),
    },
    {
      kernel: createClaudeCodeKernelAdapter({ cliPath: "/bin/echo", cwd }),
      target: join(cwd, ".claude", "skills", "native-demo", "SKILL.md"),
    },
    {
      kernel: createHermesKernelAdapter(),
      target: join(cwd, APP_CONFIG_DIR, "native-skills", "hermes", "native-demo", "SKILL.md"),
    },
    {
      kernel: new OpenCodeKernelAdapter({ cwd }),
      target: join(cwd, ".opencode", "skills", "native-demo", "SKILL.md"),
    },
    {
      kernel: new KimiKernelAdapter({ cwd }),
      target: join(cwd, ".kimi-code", "skills", "native-demo", "SKILL.md"),
    },
  ];

  assert.deepEqual(OPENCODE_KERNEL_CONTRACT.inputFormats.skillInvocation, {
    withArgs: "Use the native OpenCode skill {name} for this request.\n\n{args}",
    withoutArgs: "Use the native OpenCode skill {name} for this request.",
  });
  assert.deepEqual(KIMI_KERNEL_CONTRACT.inputFormats.skillInvocation, {
    withArgs: "/skill:{name} {args}",
    withoutArgs: "/skill:{name}",
    promptPlacement: "prompt-prefix",
  });

  let customPiInput = "";
  const customPiRuntime: AgentRuntime = {
    async *runTurn(request) {
      customPiInput = request.input;
      const runId = request.runId || "custom-pi-contract";
      yield { type: "model.response", runId, response: { text: "ok" } };
      yield { type: "turn.finished", runId, at: new Date().toISOString() };
    },
  };
  const customPiKernel = createRuntimeKernelAdapter({
    id: "pi",
    title: "Custom Pi",
    runtime: customPiRuntime,
    capabilities: {
      knowledge: {
        nativeSkills: true,
        toolMediatedSkills: false,
        progressiveDisclosure: true,
        nativeArtifacts: false,
        deliveryLedger: true,
      },
    },
    contract: {
      ...PI_KERNEL_CONTRACT,
      inputFormats: {
        ...PI_KERNEL_CONTRACT.inputFormats,
        skillInvocation: {
          withArgs: "CUSTOM:{name}:{args}",
          withoutArgs: "CUSTOM:{name}",
        },
      },
    },
  });
  const customPiApp = createOpenGrove({ cwd, readPage: () => ({}), kernel: customPiKernel });
  for await (const _event of customPiApp.runTurn("custom args", { requestedSkillName: "native-demo" })) {
    // Consume the custom adapter turn.
  }
  assert.equal(
    customPiInput,
    "CUSTOM:native-demo:custom args",
    "an injected adapter contract must override the built-in registry contract for the same kernel id",
  );

  for (const { kernel, target } of kernels) {
    const app = createOpenGrove({
      cwd,
      readPage: () => ({
        title: "Native Skill Page",
        url: "https://example.test/native-skill",
        visibleText: "Native demo skill for publisher verification.",
      }),
      kernel,
      sessionId: `native-skill-harness-${kernel.id}`,
    });

    assert.equal(existsSync(target), false, `${kernel.id} should not receive an implicit native skill copy`);
    publishNativeSkills({
      cwd,
      kernelId: kernel.id,
      kernelCapabilities: kernel.capabilities,
      skills: app.skills.list(),
    });
    assert.ok(existsSync(target), `${kernel.id} should still support explicit user-triggered publication`);
    if (kernel.capabilities.knowledge?.toolMediatedSkills) {
      assert.ok(
        app.tools.get("skill.invoke"),
        `${kernel.id} should expose OpenGrove skill.invoke when the kernel declares tool-mediated skills`,
      );
    } else {
      assert.ok(
        !app.tools.get("skill.invoke"),
        `${kernel.id} should not receive a duplicate OpenGrove skill.invoke tool`,
      );
    }
  }

  const fakeHermesGateway = join(cwd, "fake-hermes-gateway.mjs");
  writeFakeHermesGateway(fakeHermesGateway, { marker: "FAKE_HERMES_NATIVE_SKILL_OK", skipBlockingPrompts: true });
  const hermesRuntimeKernel = createHermesKernelAdapter({
    command: process.execPath,
    gatewayCommand: process.execPath,
    gatewayArgs: [fakeHermesGateway],
    cwd,
  });
  const app = createOpenGrove({
    cwd,
    readPage: () => ({
      title: "Native Skill Page",
      url: "https://example.test/native-skill",
      visibleText: "Native demo skill for publisher verification.",
    }),
    kernel: hermesRuntimeKernel,
    sessionId: "native-skill-harness",
  });

  const events = [];
  for await (const event of app.runTurn("Run native demo", { requestedSkillName: "native-demo" })) {
    events.push(event);
  }
  await hermesRuntimeKernel.dispose();

  const request = events.find((event) => event.type === "model.requested");
  assert.ok(request && request.type === "model.requested", "model.requested should be emitted");
  assert.ok(
    !request.request.context?.promptBlock.includes("SHOULD_NOT_BE_HOST_INJECTED"),
    "native skill body should not be host-injected into assembled context",
  );
  assert.ok(
    request.request.tools.every((tool) => tool.id !== "skill.invoke"),
    "runtime request should not include skill.invoke for native skill kernels",
  );
  assert.ok(
    app.knowledge
      .listDeliveries()
      .some((delivery) => delivery.knowledgeId === "skill.native-demo" && delivery.mode === "native_skill"),
    "skill delivery should be recorded as native_skill",
  );
}

function bundledSkillFixture(tempRoot: string, name: string): SkillManifest {
  const skillRoot = join(tempRoot, "src", "skills", "bundled", name);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
    "utf8",
  );
  return {
    id: `skill.${name}`,
    name,
    title: name,
    description: `${name} skill`,
    entry: join(skillRoot, "SKILL.md"),
    skillFile: join(skillRoot, "SKILL.md"),
    skillRoot,
    skillName: name,
    source: "bundled",
    trust: "trusted",
    frontmatter: {},
    interfaceMetadata: {},
    body: "",
  } as unknown as SkillManifest;
}

function prunePass() {
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-native-prune-"));
  const capabilities = { knowledge: { nativeSkills: true } } as unknown as KernelCapabilities;
  const targetRoot = join(tempRoot, ".codex", "skills");
  const publish = (skills: SkillManifest[]) =>
    publishNativeSkills({ cwd: tempRoot, kernelId: "codex", kernelCapabilities: capabilities, skills });

  // 首次发布:两个 skill 落地,带管理标记。
  const first = publish([bundledSkillFixture(tempRoot, "alpha-skill"), bundledSkillFixture(tempRoot, "beta-skill")]);
  assert.equal(first.get("skill.alpha-skill")?.[0]?.status, "published");
  assert.ok(existsSync(join(targetRoot, "beta-skill", ".opengrove-native-skill.json")));

  // 用户手写的无标记目录:发布器不得碰。
  const userDir = join(targetRoot, "my-own-skill");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "SKILL.md"), "user skill\n", "utf8");

  // 手动 republish 通道(extension manager)发的拷贝:prune 不回收。
  const manualDir = join(targetRoot, "manually-published");
  mkdirSync(manualDir, { recursive: true });
  writeFileSync(join(manualDir, "SKILL.md"), "manual\n", "utf8");
  writeFileSync(
    join(manualDir, ".opengrove-native-skill.json"),
    `${JSON.stringify(
      {
        managedBy: "opengrove",
        kernelId: "codex",
        sourceRoot: join(tempRoot, "some", "user", "skill"),
        skillName: "manually-published",
        republishedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // 改名场景:alpha-skill -> alpha-renamed,旧拷贝应被回收并留痕。
  const second = publish([bundledSkillFixture(tempRoot, "alpha-renamed"), bundledSkillFixture(tempRoot, "beta-skill")]);
  assert.equal(existsSync(join(targetRoot, "alpha-skill")), false, "renamed skill's old copy should be pruned");
  const prunedRecord = second.get("skill.alpha-skill")?.find((record) => record.status === "pruned");
  assert.ok(prunedRecord, "prune should be recorded in publication records");
  assert.equal(prunedRecord?.reason, "source_skill_no_longer_in_catalog");
  assert.ok(existsSync(join(targetRoot, "beta-skill", "SKILL.md")));
  assert.ok(existsSync(join(userDir, "SKILL.md")), "unmarked user skill must never be touched");
  assert.ok(existsSync(join(manualDir, "SKILL.md")), "manually republished skill must not be pruned");

  // 删除场景:beta-skill 从 catalog 消失,拷贝应被回收。
  const third = publish([bundledSkillFixture(tempRoot, "alpha-renamed")]);
  assert.equal(existsSync(join(targetRoot, "beta-skill")), false, "removed skill's copy should be pruned");
  assert.ok(third.get("skill.beta-skill")?.some((record) => record.status === "pruned"));

  // 幂等:稳态重发,零 prune。
  const fourth = publish([bundledSkillFixture(tempRoot, "alpha-renamed")]);
  const fourthPrunes = [...fourth.values()].flat().filter((record) => record.status === "pruned");
  assert.equal(fourthPrunes.length, 0, "steady state must not prune anything");

  // 标记损坏的目录不被误删。
  const brokenDir = join(targetRoot, "broken-marker");
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, ".opengrove-native-skill.json"), "not json", "utf8");
  publish([bundledSkillFixture(tempRoot, "alpha-renamed")]);
  assert.ok(existsSync(brokenDir), "directories with unreadable markers must be left alone");

  const marker = JSON.parse(readFileSync(join(targetRoot, "alpha-renamed", ".opengrove-native-skill.json"), "utf8"));
  assert.equal(marker.managedBy, "opengrove");
}

prunePass();

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
