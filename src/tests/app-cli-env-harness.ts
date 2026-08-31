import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { BridgeState } from "../server/bridge-types.js";
import {
  ensureMountedAppCliReady,
  resolveMountedAppCliCommand,
  resolveMountedAppDeclaredCliCommand,
  resolveMountedAppCliEnv,
} from "../server/app-cli-env.js";
import { createAppCommandRunTool, runAppCommandProcess } from "../tools/app-command.js";

const tmp = mkdtempSync(join(tmpdir(), "opengrove-app-cli-env-"));
const appRoot = join(tmp, "mounted-app");
mkdirSync(appRoot, { recursive: true });

let observedWindowsHide: boolean | undefined;
const hiddenWindowResult = await runAppCommandProcess("demo-cli.exe", ["sync"], appRoot, undefined, {
  execute: async (_command, _args, _cwd, _runtimeEnv, spawnPolicy) => {
    observedWindowsHide = spawnPolicy.windowsHide;
    return { exitCode: 0, stdout: "ok", stderr: "" };
  },
});
assert.equal(hiddenWindowResult.exitCode, 0);
assert.equal(observedWindowsHide, true, "App commands must not open a visible Windows console window");

const cliPath = join(appRoot, "bin", "demo-cli");
const doctorPath = process.platform === "win32" ? join(appRoot, "bin", "demo-cli-doctor.cmd") : cliPath;
mkdirSync(dirname(cliPath), { recursive: true });
writeFileSync(cliPath, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
if (doctorPath !== cliPath) writeFileSync(doctorPath, "@exit /b 0\r\n", "utf8");
chmodSync(cliPath, 0o755);

function elf64(machine: number): Buffer {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
  header.writeUInt16LE(machine, 18);
  return header;
}

writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: {
        cli: [
          {
            id: "demo-cli",
            path: "bin/demo-cli",
            env: ["APP_CLI_PRESENT_KEY", "APP_CLI_MISSING_KEY"],
            doctor: `${doctorPath} doctor`,
          },
          {
            id: "ready-cli",
            env: ["APP_CLI_PRESENT_KEY"],
          },
        ],
      },
    },
    null,
    2,
  ),
  "utf8",
);

process.env.APP_CLI_PRESENT_KEY = "present-value";
delete process.env.APP_CLI_MISSING_KEY;

const state = {
  settings: {
    mountedApps: [{ id: "cli-app", path: appRoot, enabled: true }],
  },
} as unknown as BridgeState;

const resolved = resolveMountedAppCliEnv(state, "cli-app");
assert.ok(resolved);
assert.equal(resolved.appId, "cli-app");
assert.equal(resolved.env.APP_CLI_PRESENT_KEY, "present-value");
assert.ok(
  resolved.env.PATH?.split(delimiter).slice(0, 2).includes(dirname(cliPath)),
  "cli dir should be prepended to PATH",
);
assert.deepEqual(resolved.injectedEnv, ["APP_CLI_PRESENT_KEY", "PATH"]);
assert.equal(resolved.missingEnv.length, 1);
assert.equal(resolved.missingEnv[0]?.cliId, "demo-cli");
assert.deepEqual(resolved.missingEnv[0]?.env, ["APP_CLI_MISSING_KEY"]);

const resolvedWithRuntimeEnv = resolveMountedAppCliEnv(state, "cli-app", undefined, {
  APP_CLI_MISSING_KEY: "runtime-secret-value",
});
assert.ok(resolvedWithRuntimeEnv);
assert.equal(resolvedWithRuntimeEnv.env.APP_CLI_MISSING_KEY, "runtime-secret-value");
assert.equal(resolvedWithRuntimeEnv.missingEnv.length, 0);

// doctor passes → readiness ok despite missing env (CLI self-discovers credentials).
const readyWithDoctor = await ensureMountedAppCliReady(resolved);
assert.equal(readyWithDoctor.ok, true);

// doctor fails → readiness fails with an explanatory message naming the env key.
writeFileSync(
  doctorPath,
  process.platform === "win32"
    ? "@echo auth missing 1>&2\r\n@exit /b 1\r\n"
    : "#!/bin/sh\necho 'auth missing' >&2\nexit 1\n",
  "utf8",
);
const failed = await ensureMountedAppCliReady(resolved);
assert.equal(failed.ok, false);
assert.ok(failed.message?.includes("APP_CLI_MISSING_KEY"));
assert.ok(failed.message?.includes("demo-cli"));
const failedWithoutMissingEnv = await ensureMountedAppCliReady(resolvedWithRuntimeEnv);
assert.equal(failedWithoutMissingEnv.ok, false, "declared doctor must run even when no env key is missing");
assert.ok(failedWithoutMissingEnv.message?.includes("readiness check"));
const failedWithoutMissingEnvZh = await ensureMountedAppCliReady(resolvedWithRuntimeEnv, "zh-CN");
assert.ok(failedWithoutMissingEnvZh.message?.includes("自检"));

// declaration without doctor and with missing env → fails fast with the key name.
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: {
        cli: [{ id: "no-doctor-cli", env: ["APP_CLI_MISSING_KEY"] }],
      },
    },
    null,
    2,
  ),
  "utf8",
);
const noDoctor = resolveMountedAppCliEnv(state, "cli-app");
assert.ok(noDoctor);
const noDoctorReadiness = await ensureMountedAppCliReady(noDoctor);
assert.equal(noDoctorReadiness.ok, false);
assert.ok(noDoctorReadiness.message?.includes("APP_CLI_MISSING_KEY"));

// The documented shape (opengrove-vfs): command: "./bin/..." + doctor: ["doctor"] means
// "run the declared CLI's doctor subcommand", and the command dir joins PATH (P1+P2 regression).
const commandCliPath = join(appRoot, "bin", "supply-drama");
writeFileSync(commandCliPath, "#!/usr/bin/env node\nprocess.exit(process.argv[2] === 'doctor' ? 0 : 1);\n", "utf8");
chmodSync(commandCliPath, 0o755);
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: {
        cli: [
          {
            id: "supply-drama-query",
            command: "./bin/supply-drama",
            doctor: ["doctor"],
            env: ["APP_CLI_MISSING_KEY"],
          },
        ],
      },
    },
    null,
    2,
  ),
  "utf8",
);
const commandShape = resolveMountedAppCliEnv(state, "cli-app");
assert.ok(commandShape);
assert.ok(
  commandShape.env.PATH?.split(delimiter).slice(0, 2).includes(dirname(commandCliPath)),
  "command dir should be prepended to PATH",
);
const commandShapeReadiness = await ensureMountedAppCliReady(commandShape);
assert.equal(
  commandShapeReadiness.ok,
  true,
  `doctor: ["doctor"] must run as the CLI's subcommand, got: ${commandShapeReadiness.message}`,
);

// Failing doctor subcommand still blocks with the env key named.
writeFileSync(
  commandCliPath,
  "#!/usr/bin/env node\nprocess.stderr.write('metabase env missing\\n');\nprocess.exit(1);\n",
  "utf8",
);
const commandShapeFailed = await ensureMountedAppCliReady(resolveMountedAppCliEnv(state, "cli-app")!);
assert.equal(commandShapeFailed.ok, false);
assert.ok(commandShapeFailed.message?.includes("APP_CLI_MISSING_KEY"));
assert.ok(commandShapeFailed.message?.includes("metabase env missing"));

// bin: bare name resolves under appRoot/bin for PATH injection.
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: {
        cli: [{ bin: "supply-drama", env: ["APP_CLI_PRESENT_KEY"] }],
      },
    },
    null,
    2,
  ),
  "utf8",
);
const binShape = resolveMountedAppCliEnv(state, "cli-app");
assert.ok(binShape);
assert.ok(
  binShape.env.PATH?.split(delimiter).slice(0, 2).includes(dirname(commandCliPath)),
  "bin dir should be prepended to PATH",
);
assert.equal(binShape.missingEnv.length, 0);

// command: bare name follows the mounted-app scanner semantics: prefer appRoot/bin, otherwise system PATH.
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: {
        cli: [{ command: "supply-drama", env: ["APP_CLI_PRESENT_KEY"] }],
      },
    },
    null,
    2,
  ),
  "utf8",
);
const bareCommandShape = resolveMountedAppCliEnv(state, "cli-app");
assert.ok(bareCommandShape);
assert.ok(
  bareCommandShape.env.PATH?.split(delimiter).slice(0, 2).includes(dirname(commandCliPath)),
  "bare command should resolve appRoot/bin first",
);
assert.equal(bareCommandShape.missingEnv.length, 0);

// Independently installed CLIs remain available when the desktop app was launched
// with a minimal PATH. The App declares the command, but does not bundle it.
const independentHome = join(tmp, "independent-cli-home");
const independentAppData = join(independentHome, "AppData", "Roaming");
const independentCliPath =
  process.platform === "win32"
    ? join(independentAppData, "npm", "independent-cli.cmd")
    : join(independentHome, ".hermes", "node", "bin", "independent-cli");
const independentBinPath =
  process.platform === "win32"
    ? join(independentAppData, "npm", "independent-bin.cmd")
    : join(independentHome, ".local", "bin", "independent-bin");
mkdirSync(dirname(independentCliPath), { recursive: true });
mkdirSync(dirname(independentBinPath), { recursive: true });
writeFileSync(
  independentCliPath,
  process.platform === "win32" ? "@exit /b 0\r\n" : "#!/usr/bin/env node\nprocess.exit(0);\n",
  "utf8",
);
writeFileSync(
  independentBinPath,
  process.platform === "win32" ? "@exit /b 0\r\n" : "#!/usr/bin/env node\nprocess.exit(0);\n",
  "utf8",
);
chmodSync(independentCliPath, 0o755);
chmodSync(independentBinPath, 0o755);
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: {
        cli: [{ command: "independent-cli", doctor: ["auth", "status"] }, { bin: "independent-bin" }],
      },
    },
    null,
    2,
  ),
  "utf8",
);
const independentCliShape = resolveMountedAppCliEnv(
  state,
  "cli-app",
  undefined,
  {},
  {
    platform: process.platform,
    execPath: process.execPath,
    tempRoot: tmp,
    userHome: independentHome,
    environment: { PATH: join(tmp, "minimal-desktop-path"), APPDATA: independentAppData },
  },
);
assert.ok(independentCliShape);
assert.ok(
  independentCliShape.env.PATH?.split(delimiter).slice(0, 2).includes(dirname(independentCliPath)),
  "a declared global CLI should be resolved from common user-level install directories",
);
const independentDoctorInvocation = independentCliShape.doctors[0]?.invocation;
assert.ok(independentDoctorInvocation);
if (process.platform === "win32") {
  assert.equal(independentDoctorInvocation.args[3], independentCliPath);
} else {
  assert.equal(independentDoctorInvocation.command, process.execPath);
  assert.equal(independentDoctorInvocation.args[0], independentCliPath);
  assert.deepEqual(independentDoctorInvocation.args.slice(1), ["auth", "status"]);
  assert.equal(independentDoctorInvocation.env?.ELECTRON_RUN_AS_NODE, "1");
}
assert.ok(
  independentCliShape.env.PATH?.includes(dirname(independentBinPath)),
  "a bare bin declaration should resolve an independently installed CLI too",
);

writeFileSync(
  commandCliPath,
  "#!/usr/bin/env node\nif (process.argv[2] === 'doctor') process.stdout.write('app-command-ok');\nelse process.exit(1);\n",
  "utf8",
);
const agentHandledCliPath = join(appRoot, "bin", "agent-handled-cli");
const silentCliPath = join(appRoot, "bin", "silent-cli");
const structuredCliPath = join(appRoot, "bin", "structured-cli");
const largeJsonCliPath = join(appRoot, "bin", "large-json-cli");
writeFileSync(
  agentHandledCliPath,
  "#!/usr/bin/env node\nif (!process.env.APP_CLI_MISSING_KEY) { process.stderr.write('APP_CLI_MISSING_KEY is required'); process.exit(9); }\n",
  "utf8",
);
chmodSync(agentHandledCliPath, 0o755);
writeFileSync(silentCliPath, "#!/usr/bin/env node\n", "utf8");
chmodSync(silentCliPath, 0o755);
writeFileSync(
  structuredCliPath,
  "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ appId: 'spoofed-app', exitCode: 99, stdoutTruncated: true, payload: 'trusted-business-value' }));\n",
  "utf8",
);
chmodSync(structuredCliPath, 0o755);
writeFileSync(
  largeJsonCliPath,
  "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ payload: '暗'.repeat(100000) }));\n",
  "utf8",
);
chmodSync(largeJsonCliPath, 0o755);
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: {
        cli: [
          { id: "supply-drama-id", command: "supply-drama" },
          { id: "agent-handled-cli", command: "agent-handled-cli", env: ["APP_CLI_MISSING_KEY"] },
          { id: "silent-cli", command: "silent-cli" },
          { id: "structured-cli", command: "structured-cli" },
          { id: "large-json-cli", command: "large-json-cli" },
        ],
      },
    },
    null,
    2,
  ),
  "utf8",
);
const appCommandRun = createAppCommandRunTool(
  {
    id: "opengrove.app.command.run",
    title: "Run mounted App command",
    description: "Harness command runner",
    activity: "local",
    risk: "write",
    input: { type: "json-schema", schema: { type: "object" } },
    permission: { mode: "allow", reason: "harness" },
  },
  {
    resolveApp(appId) {
      return appId === "cli-app" ? { id: "cli-app", appRoot } : undefined;
    },
    resolveRuntimeEnv(appId) {
      return resolveMountedAppCliEnv(state, appId)?.env;
    },
    resolveCommand(appId, commandId, args) {
      return resolveMountedAppDeclaredCliCommand(state, appId, commandId, args);
    },
  },
);
const appCommandResult = await appCommandRun.execute(
  {
    appId: "cli-app",
    commandId: "supply-drama-id",
    args: ["doctor"],
    parseJson: false,
  },
  {} as any,
);
assert.equal(appCommandResult.ok, true);
assert.match(String((appCommandResult as any).value?.stdout ?? ""), /app-command-ok/);
const silentCommandResult = await appCommandRun.execute(
  {
    appId: "cli-app",
    commandId: "silent-cli",
  },
  {} as any,
);
assert.equal(silentCommandResult.ok, true, "an exit-zero command with empty stdout must remain a success");
assert.equal("stdout" in (silentCommandResult.value as Record<string, unknown>), false);
assert.equal("json" in (silentCommandResult.value as Record<string, unknown>), false);
const structuredCommandResult = await appCommandRun.execute(
  {
    appId: "cli-app",
    commandId: "structured-cli",
  },
  {} as any,
);
assert.equal(structuredCommandResult.ok, true);
const structuredCommandValue = structuredCommandResult.value as Record<string, unknown>;
assert.equal(structuredCommandValue.appId, "cli-app", "App JSON must not override Host-owned identity");
assert.equal(structuredCommandValue.exitCode, 0, "App JSON must not override the real process exit code");
assert.equal(structuredCommandValue.stdoutTruncated, false, "App JSON must not override Host truncation state");
assert.deepEqual(structuredCommandValue.json, {
  appId: "spoofed-app",
  exitCode: 99,
  stdoutTruncated: true,
  payload: "trusted-business-value",
});
const invalidStructuredCommandResult = await appCommandRun.execute(
  {
    appId: "cli-app",
    commandId: "supply-drama-id",
    args: ["doctor"],
  },
  {} as any,
);
assert.deepEqual(invalidStructuredCommandResult, { ok: false, error: "command_output_not_json" });
const oversizedStructuredCommandResult = await appCommandRun.execute(
  {
    appId: "cli-app",
    commandId: "large-json-cli",
  },
  {} as any,
);
assert.equal(oversizedStructuredCommandResult.ok, false);
assert.equal(oversizedStructuredCommandResult.error, "structured_output_too_large");
const truncatedTextCommandResult = await appCommandRun.execute(
  {
    appId: "cli-app",
    commandId: "large-json-cli",
    parseJson: false,
  },
  {} as any,
);
assert.equal(truncatedTextCommandResult.ok, true);
assert.equal((truncatedTextCommandResult.value as Record<string, unknown>).stdoutTruncated, true);
assert.equal(typeof (truncatedTextCommandResult.value as Record<string, unknown>).stdout, "string");
const agentHandledFailure = await appCommandRun.execute(
  {
    appId: "cli-app",
    commandId: "agent-handled-cli",
    parseJson: false,
  },
  {} as any,
);
assert.equal(agentHandledFailure.ok, false);
assert.match(
  agentHandledFailure.error ?? "",
  /command_failed:9:APP_CLI_MISSING_KEY is required/,
  "the Host Tool should return the CLI's actual failure for the Employee to handle instead of pre-blocking execution",
);
assert.deepEqual(
  await appCommandRun.execute(
    {
      appId: "cli-app",
      commandId: "supply-drama",
      args: ["doctor"],
    },
    {} as any,
  ),
  { ok: false, error: "app_command_not_declared" },
);
const undeclaredCommandResult = await appCommandRun.execute(
  {
    appId: "cli-app",
    command: "/bin/echo",
    args: ["must-not-run"],
    parseJson: false,
  },
  {} as any,
);
assert.deepEqual(undeclaredCommandResult, { ok: false, error: "command_id_required" });
assert.deepEqual(
  await appCommandRun.execute(
    {
      appId: "cli-app",
      commandId: "supply-drama-id",
      args: Array.from({ length: 101 }, () => "x"),
    },
    {} as any,
  ),
  { ok: false, error: "command_arguments_too_large" },
);

writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "cli-app",
    title: "CLI App",
    capabilities: {
      cli: [
        {
          id: "node-script-with-args",
          command: "node",
          args: ["--experimental-vm-modules", "scripts/task.mjs", "--fixed"],
        },
      ],
    },
  }),
  "utf8",
);
mkdirSync(join(appRoot, "scripts"), { recursive: true });
writeFileSync(
  join(appRoot, "scripts", "task.mjs"),
  "#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(','));\n",
  "utf8",
);
const nodeArgsInvocation = resolveMountedAppDeclaredCliCommand(state, "cli-app", "node-script-with-args", ["runtime"], {
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  tempRoot: tmp,
  environment: process.env,
});
assert.ok(nodeArgsInvocation);
assert.match(nodeArgsInvocation.command.replaceAll("\\", "/").split("/").pop() ?? "", /^node(?:\.exe)?$/i);
assert.deepEqual(
  nodeArgsInvocation.args,
  ["--experimental-vm-modules", join(appRoot, "scripts", "task.mjs"), "--fixed", "runtime"],
  "manifest args must remain ahead of command.run arguments without shell concatenation",
);
const nodeArgsRun = await appCommandRun.execute(
  {
    appId: "cli-app",
    commandId: "node-script-with-args",
    args: ["runtime"],
    parseJson: false,
  },
  {} as any,
);
assert.equal(nodeArgsRun.ok, true);
assert.equal((nodeArgsRun as any).value?.stdout, "--fixed,runtime");
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "cli-app",
    title: "CLI App",
    capabilities: {
      cli: [
        {
          id: "missing-node-script",
          command: "node",
          args: ["--experimental-vm-modules", "scripts/missing.mjs"],
        },
      ],
    },
  }),
  "utf8",
);
assert.throws(
  () => resolveMountedAppDeclaredCliCommand(state, "cli-app", "missing-node-script", []),
  /app_command_script_missing/,
  "managed execution must re-check an App-owned script after install",
);
writeFileSync(join(tmp, "outside-task.mjs"), "process.stdout.write('outside');\n", "utf8");
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "cli-app",
    title: "CLI App",
    capabilities: {
      cli: [
        {
          id: "outside-node-script",
          command: "node",
          args: ["../outside-task.mjs"],
        },
      ],
    },
  }),
  "utf8",
);
assert.throws(
  () => resolveMountedAppDeclaredCliCommand(state, "cli-app", "outside-node-script", []),
  /app_command_script_outside_app/,
  "managed execution must reject a Node script outside the App root",
);
const linkedOutsideScript =
  process.platform === "win32"
    ? join(appRoot, "scripts", "linked-outside", "outside-task.mjs")
    : join(appRoot, "scripts", "linked-outside.mjs");
if (process.platform === "win32") {
  const linkedOutsideRoot = join(tmp, "linked-outside-root");
  mkdirSync(linkedOutsideRoot, { recursive: true });
  writeFileSync(join(linkedOutsideRoot, "outside-task.mjs"), "process.stdout.write('outside');\n", "utf8");
  symlinkSync(linkedOutsideRoot, dirname(linkedOutsideScript), "junction");
} else {
  symlinkSync(join(tmp, "outside-task.mjs"), linkedOutsideScript);
}
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "cli-app",
    title: "CLI App",
    capabilities: {
      cli: [
        {
          id: "linked-outside-node-script",
          command: "node",
          args: [
            process.platform === "win32" ? "scripts/linked-outside/outside-task.mjs" : "scripts/linked-outside.mjs",
          ],
        },
      ],
    },
  }),
  "utf8",
);
assert.throws(
  () => resolveMountedAppDeclaredCliCommand(state, "cli-app", "linked-outside-node-script", []),
  /app_command_script_outside_app/,
  "managed execution must resolve symlinks before accepting an App-owned script",
);

// A declared target map is resolved only from the actual Host process platform/architecture.
// Wrong-format, wrong-architecture, missing, or non-executable artifacts must fail before spawn.
const portableAppRoot = join(tmp, "portable-app");
const portableLinuxX64 = join(portableAppRoot, "bin", "linux-x64", "editorial-sync");
const portableLinuxArm64 = join(portableAppRoot, "bin", "linux-arm64", "editorial-sync");
mkdirSync(dirname(portableLinuxX64), { recursive: true });
mkdirSync(dirname(portableLinuxArm64), { recursive: true });
writeFileSync(portableLinuxX64, elf64(0x3e));
writeFileSync(portableLinuxArm64, elf64(0xb7));
chmodSync(portableLinuxX64, 0o755);
chmodSync(portableLinuxArm64, 0o755);
writeFileSync(
  join(portableAppRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "portable-app",
    title: "Portable App",
    capabilities: {
      cli: [
        {
          id: "editorial-sync",
          command: "./bin/editorial-sync",
          targets: {
            "linux-x64": "./bin/linux-x64/editorial-sync",
            "linux-arm64": "./bin/linux-arm64/editorial-sync",
          },
        },
      ],
    },
  }),
  "utf8",
);
const portableState = {
  settings: { mountedApps: [{ id: "portable-app", path: portableAppRoot, enabled: true }] },
} as unknown as BridgeState;
const linuxX64Host = {
  platform: "linux" as const,
  arch: "x64" as const,
  execPath: "/usr/bin/node",
  tempRoot: tmp,
};
if (process.platform !== "win32") {
  assert.deepEqual(
    resolveMountedAppDeclaredCliCommand(portableState, "portable-app", "editorial-sync", ["sync"], linuxX64Host),
    { command: portableLinuxX64, args: ["sync"] },
  );
  assert.deepEqual(
    resolveMountedAppCliCommand(portableState, "portable-app", "./bin/editorial-sync", ["sync"], linuxX64Host),
    { command: portableLinuxX64, args: ["sync"] },
    "the temporary Routine compatibility field must match the exact declared command",
  );
  assert.equal(
    resolveMountedAppCliCommand(portableState, "portable-app", "./bin/linux-x64/editorial-sync", [], linuxX64Host),
    undefined,
    "a Routine cannot bypass the declaration by naming a platform artifact directly",
  );

  writeFileSync(portableLinuxX64, elf64(0xb7));
  assert.throws(
    () => resolveMountedAppDeclaredCliCommand(portableState, "portable-app", "editorial-sync", [], linuxX64Host),
    /app_command_target_arch_mismatch:linux-x64/,
  );
  writeFileSync(portableLinuxX64, elf64(0x3e));
  chmodSync(portableLinuxX64, 0o644);
  assert.throws(
    () => resolveMountedAppDeclaredCliCommand(portableState, "portable-app", "editorial-sync", [], linuxX64Host),
    /app_command_target_not_executable:linux-x64/,
  );
  chmodSync(portableLinuxX64, 0o755);
  writeFileSync(portableLinuxX64, "#!/bin/sh\nexit 0\n", "utf8");
  assert.throws(
    () => resolveMountedAppDeclaredCliCommand(portableState, "portable-app", "editorial-sync", [], linuxX64Host),
    /app_command_target_format_mismatch:linux-x64/,
  );
}
writeFileSync(
  join(portableAppRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "portable-app",
    title: "Portable App",
    capabilities: {
      cli: [
        {
          id: "editorial-sync",
          command: "./bin/editorial-sync",
          targets: { "linux-arm64": "./bin/linux-arm64/editorial-sync" },
        },
      ],
    },
  }),
  "utf8",
);
assert.throws(
  () => resolveMountedAppDeclaredCliCommand(portableState, "portable-app", "editorial-sync", [], linuxX64Host),
  /app_command_target_missing:linux-x64/,
);

// employees-scoped declarations only apply to the named employee slugs.
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: {
        cli: [{ id: "producer-cli", env: ["APP_CLI_MISSING_KEY"], employees: ["producer"] }],
      },
    },
    null,
    2,
  ),
  "utf8",
);
const producerScoped = resolveMountedAppCliEnv(state, "cli-app", "member-app-cli-app-producer");
assert.ok(producerScoped, "declaration should apply to the named employee");
assert.equal(producerScoped.missingEnv.length, 1);
assert.equal(
  resolveMountedAppCliEnv(state, "cli-app", "member-app-cli-app-material"),
  undefined,
  "declaration should not apply to other employees",
);
assert.equal(
  resolveMountedAppCliEnv(state, "cli-app", "member-app-cli-app-senior-producer"),
  undefined,
  "employee slug matching should be exact",
);

writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "short-drama-studio",
      title: "Short Drama Studio",
      capabilities: {
        cli: [{ id: "ad-cli", env: ["APP_CLI_MISSING_KEY"], employees: ["ad-buyer"] }],
      },
    },
    null,
    2,
  ),
  "utf8",
);
assert.ok(
  resolveMountedAppCliEnv(state, "short-drama-studio", "member-app-short-drama-studio-ad%2Dbuyer"),
  "hyphenated employee slugs should match exactly",
);
assert.equal(
  resolveMountedAppCliEnv(state, "short-drama-studio", "member-app-short-drama-studio-buyer"),
  undefined,
  "hyphenated employee slugs should not match partial suffixes",
);

// PATH 缺 node 时，注入后的员工 PATH 必须能重新解析到桥的 Node 运行时——
// app CLI 多为 #!/usr/bin/env node 脚本，Finder 启动的打包版继承的 PATH 里没有 node。
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: { cli: [{ id: "demo-cli", path: "bin/demo-cli" }] },
    },
    null,
    2,
  ),
  "utf8",
);
const emptyBinDir = join(tmp, "no-node-bin");
mkdirSync(emptyBinDir, { recursive: true });
const originalPath = process.env.PATH;
process.env.PATH = emptyBinDir;
try {
  const nodeless = resolveMountedAppCliEnv(state, "cli-app");
  assert.ok(nodeless);
  assert.ok(
    nodeless.env.PATH?.split(delimiter).some(
      (dir) =>
        dir &&
        (existsSync(join(dir, "node")) || existsSync(join(dir, "node.exe")) || existsSync(join(dir, "node.cmd"))),
    ),
    "employee PATH should resolve node again when the base PATH lacks it",
  );
} finally {
  process.env.PATH = originalPath;
}

// Windows has neither Unix shebang execution nor a guaranteed system Node.js. OpenGrove
// must expose cmd shims for employee shells and resolve App Command Run directly through
// the packaged Electron executable without shell-concatenating LLM-controlled args.
const windowsRuntimeRoot = join(tmp, "Windows-中文运行时");
const windowsTempRoot = join(tmp, "Windows-中文临时目录");
const windowsExecPath = join(windowsRuntimeRoot, "OpenGrove.exe");
mkdirSync(windowsRuntimeRoot, { recursive: true });
writeFileSync(windowsExecPath, "", "utf8");
writeFileSync(cliPath, "#!/usr/bin/env -S node --no-warnings\nprocess.stdout.write('ok');\n", "utf8");
process.env.PATH = "C:\\Windows\\System32";
try {
  const host = { platform: "win32" as const, execPath: windowsExecPath, tempRoot: windowsTempRoot };
  const windowsResolution = resolveMountedAppCliEnv(state, "cli-app", undefined, {}, host);
  assert.ok(windowsResolution);
  const windowsPathEntries = (windowsResolution.env.PATH ?? "").split(";");
  assert.equal(windowsPathEntries.at(-1), "C:\\Windows\\System32");
  const nodeShim = windowsPathEntries
    .map((entry) => join(entry, "node.cmd"))
    .find((candidate) => existsSync(candidate));
  const cliShim = windowsPathEntries
    .map((entry) => join(entry, "demo-cli.cmd"))
    .find((candidate) => existsSync(candidate));
  assert.ok(nodeShim, "Windows employee PATH should expose embedded Node as node.cmd");
  assert.ok(cliShim, "Windows employee PATH should expose a .cmd launcher for the App CLI");
  const cliShimScript = readFileSync(cliShim, "utf8");
  const nodeShimScript = readFileSync(nodeShim, "utf8");
  assert.match(cliShimScript, /^@echo off\r\nchcp 65001 >nul\r\n/);
  assert.match(nodeShimScript, /^@echo off\r\nchcp 65001 >nul\r\n/);
  assert.match(cliShimScript, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(cliShimScript, /OpenGrove\.exe/);
  assert.match(cliShimScript, /中文运行时/, "UTF-8 .cmd should preserve a Chinese installation path");

  const invocation = resolveMountedAppCliCommand(state, "cli-app", "demo-cli", ["ops:submit", "项目 A"], host);
  assert.deepEqual(invocation, {
    command: windowsExecPath,
    args: [cliPath, "ops:submit", "项目 A"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
} finally {
  process.env.PATH = originalPath;
}

// npm installs global commands as .cmd shims on Windows. Both readiness doctors
// and declared command execution must invoke those shims through ComSpec while
// preserving each argument as a separate argv item.
const windowsAppData = join(tmp, "Windows-中文-AppData");
const windowsNpmBin = join(windowsAppData, "npm");
const windowsGlobalCli = join(windowsNpmBin, "global-workflow.cmd");
const windowsComSpec = "C:\\Windows\\System32\\cmd.exe";
mkdirSync(windowsNpmBin, { recursive: true });
writeFileSync(windowsGlobalCli, "@echo off\r\nexit /b 0\r\n", "utf8");
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "cli-app",
      title: "CLI App",
      capabilities: {
        cli: [
          {
            id: "global-workflow",
            command: "global-workflow",
            doctor: ["auth", "status"],
          },
        ],
      },
    },
    null,
    2,
  ),
  "utf8",
);
const windowsGlobalHost = {
  platform: "win32" as const,
  execPath: windowsExecPath,
  tempRoot: windowsTempRoot,
  userHome: join(tmp, "Windows-user"),
  environment: {
    PATH: "C:\\Windows\\System32",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    APPDATA: windowsAppData,
    ComSpec: windowsComSpec,
  },
};
const windowsGlobalResolution = resolveMountedAppCliEnv(state, "cli-app", undefined, {}, windowsGlobalHost);
assert.ok(windowsGlobalResolution);
assert.deepEqual(windowsGlobalResolution.doctors[0]?.invocation, {
  kind: "exec",
  command: windowsComSpec,
  args: ["/d", "/s", "/c", windowsGlobalCli, "auth", "status"],
  display: `${windowsGlobalCli} auth status`,
});
assert.deepEqual(
  resolveMountedAppDeclaredCliCommand(state, "cli-app", "global-workflow", ["publish", "项目 A"], windowsGlobalHost),
  {
    command: windowsComSpec,
    args: ["/d", "/s", "/c", windowsGlobalCli, "publish", "项目 A"],
  },
);
assert.deepEqual(
  resolveMountedAppCliCommand(state, "cli-app", "global-workflow", ["schedule", "项目 B"], windowsGlobalHost),
  {
    command: windowsComSpec,
    args: ["/d", "/s", "/c", windowsGlobalCli, "schedule", "项目 B"],
  },
);

// A standalone doctor string must use argv-based execution and the same embedded Node
// runtime as the real App CLI, including when the script path contains spaces.
const doctorWithSpacesRoot = join(tmp, "doctor app with spaces");
const doctorWithSpacesCli = join(doctorWithSpacesRoot, "bin", "doctor cli.js");
mkdirSync(dirname(doctorWithSpacesCli), { recursive: true });
writeFileSync(doctorWithSpacesCli, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
writeFileSync(
  join(doctorWithSpacesRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "doctor-spaces-app",
    title: "Doctor Spaces App",
    capabilities: {
      cli: [
        {
          id: "doctor-spaces-cli",
          path: `\"${doctorWithSpacesCli}\"`,
          doctor: `\"${doctorWithSpacesCli}\" doctor`,
        },
      ],
    },
  }),
  "utf8",
);
const doctorWithSpacesState = {
  settings: { mountedApps: [{ id: "doctor-spaces-app", path: doctorWithSpacesRoot, enabled: true }] },
} as unknown as BridgeState;
const doctorWithSpacesResolution = resolveMountedAppCliEnv(
  doctorWithSpacesState,
  "doctor-spaces-app",
  undefined,
  {},
  {
    platform: "win32",
    execPath: windowsExecPath,
    tempRoot: windowsTempRoot,
  },
);
assert.ok(doctorWithSpacesResolution);
assert.deepEqual((doctorWithSpacesResolution.doctors[0] as any)?.invocation, {
  kind: "exec",
  command: windowsExecPath,
  args: [doctorWithSpacesCli, "doctor"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
  display: `${doctorWithSpacesCli} doctor`,
});

// Successful doctor results are reused for the same App/command/environment, but a
// changed runtime environment gets a fresh check.
const cachedDoctorRoot = join(tmp, "cached-doctor-app");
const cachedDoctorCli = join(cachedDoctorRoot, "bin", "cached-doctor.cjs");
const cachedDoctorCount = join(cachedDoctorRoot, "doctor-count.txt");
mkdirSync(dirname(cachedDoctorCli), { recursive: true });
writeFileSync(
  cachedDoctorCli,
  `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst path = ${JSON.stringify(cachedDoctorCount)};\nconst count = fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) : 0;\nfs.writeFileSync(path, String(count + 1));\n`,
  "utf8",
);
chmodSync(cachedDoctorCli, 0o755);
writeFileSync(
  join(cachedDoctorRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "cached-doctor-app",
    title: "Cached Doctor App",
    capabilities: {
      cli: [
        {
          id: "cached-doctor-cli",
          path: "bin/cached-doctor.cjs",
          doctor: ["doctor"],
          env: ["DOCTOR_CACHE_ENV"],
        },
      ],
    },
  }),
  "utf8",
);
const cachedDoctorState = {
  settings: { mountedApps: [{ id: "cached-doctor-app", path: cachedDoctorRoot, enabled: true }] },
} as unknown as BridgeState;
const cachedDoctorFirst = resolveMountedAppCliEnv(cachedDoctorState, "cached-doctor-app", undefined, {
  DOCTOR_CACHE_ENV: "one",
})!;
assert.equal((await ensureMountedAppCliReady(cachedDoctorFirst)).ok, true);
assert.equal((await ensureMountedAppCliReady(cachedDoctorFirst)).ok, true);
assert.equal(readFileSync(cachedDoctorCount, "utf8").trim(), "1");
const cachedDoctorChangedEnv = resolveMountedAppCliEnv(cachedDoctorState, "cached-doctor-app", undefined, {
  DOCTOR_CACHE_ENV: "two",
})!;
assert.equal((await ensureMountedAppCliReady(cachedDoctorChangedEnv)).ok, true);
assert.equal(readFileSync(cachedDoctorCount, "utf8").trim(), "2");

// app without cli declarations → undefined (zero overhead for non-CLI apps).
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify({ id: "cli-app", title: "CLI App" }, null, 2),
  "utf8",
);
assert.equal(resolveMountedAppCliEnv(state, "cli-app"), undefined);

console.log("app-cli-env-harness passed");
