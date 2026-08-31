import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

export const windowsInstallerFirewallRegistryKey = "HKCU\\Software\\OpenGrove\\Installer";

const firewallProgramValue = "LoopbackFirewallProgram";
const firewallRuleValue = "LoopbackFirewallRule";

export function seedWindowsInstallerFirewallState(installedRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("Windows installer gate state can only be seeded on Windows");
  const run = options.run ?? spawnSync;
  const program = win32.join(installedRoot, "OpenGrove.exe");
  const rule = `OpenGrove loopback TCP - ${installedRoot}`;
  const previous = new Map([
    [firewallProgramValue, readRegistryValue(run, firewallProgramValue)],
    [firewallRuleValue, readRegistryValue(run, firewallRuleValue)],
  ]);

  try {
    writeRegistryValue(run, firewallProgramValue, program);
    writeRegistryValue(run, firewallRuleValue, rule);
  } catch (error) {
    restoreRegistryValues(run, previous);
    throw error;
  }

  let restored = false;
  return {
    program,
    rule,
    restore() {
      if (restored) return;
      restored = true;
      restoreRegistryValues(run, previous);
    },
  };
}

function readRegistryValue(run, name) {
  const result = run("reg.exe", ["QUERY", windowsInstallerFirewallRegistryKey, "/v", name], { encoding: "utf8" });
  if (!result.error && result.status === 1) return undefined;
  assertRegistryResult(result, `read ${name}`);
  const pattern = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.*)$`, "mi");
  const match = result.stdout?.match(pattern);
  if (!match) throw new Error(`Windows installer gate could not parse registry value ${name}`);
  return match[1].trimEnd();
}

function writeRegistryValue(run, name, value) {
  const result = run(
    "reg.exe",
    ["ADD", windowsInstallerFirewallRegistryKey, "/v", name, "/t", "REG_SZ", "/d", value, "/f"],
    { encoding: "utf8" },
  );
  assertRegistryResult(result, `write ${name}`);
}

function restoreRegistryValues(run, previous) {
  const failures = [];
  for (const [name, value] of previous) {
    const args =
      value === undefined
        ? ["DELETE", windowsInstallerFirewallRegistryKey, "/v", name, "/f"]
        : ["ADD", windowsInstallerFirewallRegistryKey, "/v", name, "/t", "REG_SZ", "/d", value, "/f"];
    const result = run("reg.exe", args, { encoding: "utf8" });
    if (result.error || (result.status !== 0 && !(value === undefined && result.status === 1))) {
      failures.push(`${name}: ${result.error?.message || result.stderr?.trim() || result.status}`);
    }
  }
  if (failures.length > 0)
    throw new Error(`Windows installer gate could not restore registry state: ${failures.join("; ")}`);
}

function assertRegistryResult(result, action) {
  if (!result.error && result.status === 0) return;
  throw new Error(
    `Windows installer gate could not ${action}: ${result.error?.message || result.stderr?.trim() || result.status}`,
  );
}
