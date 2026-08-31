import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appEnvName } from "../identity.js";
import { createClaudeCodeKernelAdapter, resolveClaudeCodeRuntimeMode } from "../kernel/adapters/claude-code.js";
import {
  resolveBundledClaudeEngine,
  resolveClaudeCodeCliPath,
  resolveClaudeCodeCliPathDetailed,
} from "../runtime/claude-code-runtime.js";
import { withEnv } from "./env.js";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "opengrove-claude-cli-resolution-"));

  assertBundledPackageNames(root);
  assertBundledMissingIsSilent();
  assertBundledResolveWarning();
  assertAsarUnpackedPath(root);
  await assertResolverPriority(root);
  await assertRuntimeCapabilityBoundary(root);

  console.log("claude-code-cli-resolution-harness ok");
}

async function assertRuntimeCapabilityBoundary(root: string) {
  await withEnv(
    {
      [appEnvName("CLAUDE_CODE_RUNTIME")]: "cli",
    },
    () => {
      assert.equal(resolveClaudeCodeRuntimeMode(), "cli");
      const adapter = createClaudeCodeKernelAdapter({ cliPath: "/bin/echo", cwd: root });
      assert.equal(adapter.capabilities.hostTools, false);
      assert.equal(adapter.capabilities.elicitation, false);
    },
  );

  await withEnv(
    {
      [appEnvName("CLAUDE_CODE_RUNTIME")]: "sdk",
    },
    () => {
      assert.equal(resolveClaudeCodeRuntimeMode(), "sdk");
      const adapter = createClaudeCodeKernelAdapter({ cliPath: "/bin/echo", cwd: root });
      assert.equal(adapter.capabilities.hostTools, true);
      assert.equal(adapter.capabilities.elicitation, true);
    },
  );
}

function assertBundledPackageNames(root: string) {
  const darwinEngine = touchExecutable(join(root, "darwin", "claude"));
  const darwinRequests: string[] = [];
  assert.equal(
    resolveBundledClaudeEngine({
      platform: "darwin",
      arch: "arm64",
      requireResolve: (id) => {
        darwinRequests.push(id);
        return darwinEngine;
      },
    }),
    darwinEngine,
  );
  assert.deepEqual(darwinRequests, ["@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"]);

  const windowsEngine = touchExecutable(join(root, "win32", "claude.exe"));
  const windowsRequests: string[] = [];
  assert.equal(
    resolveBundledClaudeEngine({
      platform: "win32",
      arch: "x64",
      requireResolve: (id) => {
        windowsRequests.push(id);
        return windowsEngine;
      },
    }),
    windowsEngine,
  );
  assert.deepEqual(windowsRequests, ["@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"]);

  // On a glibc host, only the glibc variant is a valid candidate. The musl
  // binary cannot launch here (its loader is absent), so it must never be
  // resolved even though npm installed both optional packages.
  const linuxEngine = touchExecutable(join(root, "linux", "claude"));
  const linuxRequests: string[] = [];
  assert.equal(
    resolveBundledClaudeEngine({
      platform: "linux",
      arch: "x64",
      isMuslLibc: false,
      requireResolve: (id) => {
        linuxRequests.push(id);
        return linuxEngine;
      },
    }),
    linuxEngine,
  );
  assert.deepEqual(
    linuxRequests,
    ["@anthropic-ai/claude-agent-sdk-linux-x64/claude"],
    "glibc host must resolve only the glibc variant, never the musl one",
  );

  // On a musl host, only the musl variant is valid.
  const muslEngine = touchExecutable(join(root, "linux-musl", "claude"));
  const muslRequests: string[] = [];
  assert.equal(
    resolveBundledClaudeEngine({
      platform: "linux",
      arch: "x64",
      isMuslLibc: true,
      requireResolve: (id) => {
        muslRequests.push(id);
        return muslEngine;
      },
    }),
    muslEngine,
  );
  assert.deepEqual(
    muslRequests,
    ["@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude"],
    "musl host must resolve only the musl variant",
  );
}

function assertBundledMissingIsSilent() {
  assert.equal(
    resolveBundledClaudeEngine({
      platform: "darwin",
      arch: "arm64",
      requireResolve: () => {
        throw moduleMissingError("optional dependency missing");
      },
    }),
    undefined,
  );
}

function assertBundledResolveWarning() {
  const previousWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    assert.equal(
      resolveBundledClaudeEngine({
        platform: "darwin",
        arch: "arm64",
        requireResolve: () => {
          throw Object.assign(new Error("package exports denied"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
        },
      }),
      undefined,
      "non-missing bundled package resolution errors must not abort CLI path discovery",
    );
  } finally {
    console.warn = previousWarn;
  }
  assert.match(warnings.join("\n"), /@anthropic-ai\/claude-agent-sdk-darwin-arm64\/claude/);
  assert.match(warnings.join("\n"), /ERR_PACKAGE_PATH_NOT_EXPORTED/);
}

function assertAsarUnpackedPath(root: string) {
  const asarEngine = join(
    root,
    "OpenGrove.app",
    "Contents",
    "Resources",
    "app.asar",
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk-darwin-arm64",
    "claude",
  );
  const unpackedEngine = touchExecutable(
    join(
      root,
      "OpenGrove.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk-darwin-arm64",
      "claude",
    ),
  );

  assert.equal(
    resolveBundledClaudeEngine({
      platform: "darwin",
      arch: "arm64",
      requireResolve: () => asarEngine,
    }),
    unpackedEngine,
  );

  assert.equal(
    resolveBundledClaudeEngine({
      platform: "darwin",
      arch: "arm64",
      requireResolve: () =>
        join(root, "missing.app", "Contents", "Resources", "app.asar", "node_modules", "engine", "claude"),
    }),
    undefined,
  );
}

async function assertResolverPriority(root: string) {
  const explicitClaude = touchExecutable(join(root, "explicit", "claude"));
  const fakeHome = join(root, "home");
  const desktopClaude = touchExecutable(
    join(
      fakeHome,
      "Library",
      "Application Support",
      "Claude-3p",
      "claude-code",
      "9.9.9",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    ),
  );

  await withEnv(
    {
      HOME: fakeHome,
      [appEnvName("CLAUDE_CLI_PATH")]: explicitClaude,
    },
    () => {
      assert.equal(
        resolveClaudeCodeCliPath(root),
        explicitClaude,
        "OPENGROVE_CLAUDE_CLI_PATH must remain the highest runtime resolver priority",
      );
      assert.deepEqual(
        resolveClaudeCodeCliPathDetailed(root),
        { path: explicitClaude, source: "override" },
        "explicit OPENGROVE_CLAUDE_CLI_PATH should be reported as an override source",
      );
    },
  );

  await withEnv(
    {
      HOME: fakeHome,
      [appEnvName("CLAUDE_CLI_PATH")]: undefined,
    },
    () => {
      const resolved = resolveClaudeCodeCliPath(root);
      assert.notEqual(resolved, desktopClaude, "Bundled SDK engine should win before Claude-3p automatic discovery");
      assert.match(
        resolved ?? "",
        /node_modules[\/\\]@anthropic-ai[\/\\]claude-agent-sdk-[^\/\\]+[\/\\]claude(?:\.exe)?$/,
      );
      const detailed = resolveClaudeCodeCliPathDetailed(root);
      assert.equal(detailed?.path, resolved);
      assert.equal(detailed?.source, "bundled");
    },
  );
}

function touchExecutable(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
  return path;
}

function moduleMissingError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "MODULE_NOT_FOUND" });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
