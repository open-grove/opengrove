// Run after build:server. Uses disposable homes and evaluates native approval decisions; no model calls or shell commands are executed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { prepareHermesRuntimeEnv } from "../dist/runtime/hermes/home-env.js";
import { resolveHermesTuiGatewayLaunch } from "../dist/runtime/hermes/gateway-launch.js";
import { StdioJsonRpcClient } from "../dist/runtime/stdio-json-rpc-client.js";
const command = process.argv[2] || process.env.OPENGROVE_HERMES_BIN || process.env.HERMES_BIN || "hermes";
const launch = resolveHermesTuiGatewayLaunch({ command });
const fixture = mkdtempSync(join(tmpdir(), "opengrove-hermes-native-proof-"));
const source = join(fixture, "source");
mkdirSync(source);
writeFileSync(join(source, "config.yaml"), 'approvals:\n  mode: manual\n  deny:\n    - "*opengrove-denied-marker*"\n');
const results = [];
try {
  for (const [mode, expected] of [
    ["default", "manual"],
    ["auto-review", "smart"],
    ["full-access", "off"],
  ]) {
    const prepared = prepareHermesRuntimeEnv({
      runtimeEnv: { HERMES_HOME: source, OPENGROVE_HERMES_ISOLATED_HOME: "1" },
      accessMode: mode,
    });
    const env = { ...prepared.env, HERMES_PYTHON_SRC_ROOT: launch.pythonSourceRoot };
    let client;
    try {
      client = StdioJsonRpcClient.start({ ...launch, env, cwd: fixture });
      const answer = await client.request("config.get", { key: "approvals.mode" }, { timeoutMs: 30000 });
      assert.equal(answer.value, expected);
      const result = { mode, nativeMode: answer.value, yolo: env.HERMES_YOLO_MODE };
      if (mode !== "auto-review") {
        const probe = spawnSync(
          launch.command,
          [
            "-c",
            `
import hermes_bootstrap
hermes_bootstrap.harden_import_path()
import json
from tools.approval import request_tool_approval, check_all_command_guards
calls=[]
def decide(*args,**kwargs):
    calls.append(True)
    return 'deny'
result=request_tool_approval('opengrove_permission_contract', 'Harmless permission contract probe', approval_callback=decide)
blocked=check_all_command_guards('printf opengrove-denied-marker', 'local')
print(json.dumps({'approved': result.get('approved'), 'callbackCalls':len(calls), 'explicitDenyApproved':blocked.get('approved')}))
`,
          ],
          {
            cwd: fixture,
            env: { ...env, HERMES_INTERACTIVE: "1", HERMES_EXEC_ASK: "0", HERMES_GATEWAY_SESSION: "0" },
            encoding: "utf8",
            timeout: 20000,
          },
        );
        if (probe.status !== 0) throw new Error(probe.stderr);
        const native = JSON.parse(probe.stdout.trim().split("\n").at(-1));
        assert.equal(native.approved, mode === "full-access");
        assert.equal(native.callbackCalls, mode === "full-access" ? 0 : 1);
        assert.equal(native.explicitDenyApproved, false);
        Object.assign(result, native);
      }
      results.push(result);
    } finally {
      if (client) {
        client.close();
        await new Promise((resolve) => client.addExitHandler(resolve));
      }
      rmSync(prepared.isolatedHome, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
