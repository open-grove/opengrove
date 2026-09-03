#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./package-root.js";
import { runAppBuilderCli } from "./app-builder/cli.js";
import { runEmployeeCli } from "./app-builder/employee-cli.js";
import { isAppReleasePublishCommand, runAppReleasePublishCommand } from "./cli/app-release-command.js";
import { isAuthWorkflowCommand, runAuthCommand } from "./cli/auth-command.js";
import { createCliOpenGroveClient } from "./cli/client.js";
import {
  isHostOperationCommand,
  renderHostOperationOverview,
  runHostOperationCommand,
} from "./cli/host-operation-command.js";
import { startLocalProfile } from "./profiles/local.js";
import { startWebSingleProfile } from "./profiles/web-single.js";

type PackageInfo = {
  name: string;
  version: string;
};

const USAGE = `OpenGrove

Usage:
  opengrove start [--host HOST] [--port PORT]
  opengrove bridge [--host HOST] [--port PORT]
  opengrove web [--host HOST] [--port PORT]
  opengrove app <inspect|validate|scaffold> ...
  opengrove employee pack <memberId> [--output FILE]
  opengrove auth <login|status|logout> ...
  opengrove room message create [options]
  opengrove version

Commands:
  start, bridge   Start the local OpenGrove bridge. Browser UI requires OPENGROVE_ENABLE_BROWSER_UI=1.
  web             Start the authenticated single-user Web UI and local bridge.
  app             Inspect, scaffold, and validate portable OpenGrove Apps.
  employee        Package and publish Rooms employees.
  auth            Sign in once and share the CLI account session across commands.
  room             Call Room capabilities exposed by the Host Protocol.
  version         Print the installed OpenGrove version.

Host commands:
${renderHostOperationOverview()}
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "start";

  if (isAuthWorkflowCommand(args)) {
    const result = await runAuthCommand(args.slice(1));
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
    return;
  }

  if (isAppReleasePublishCommand(args)) {
    const result = await runAppReleasePublishCommand(args, { createClient: createCliOpenGroveClient });
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
    return;
  }

  if (isHostOperationCommand(args)) {
    const result = await runHostOperationCommand(args, { createClient: createCliOpenGroveClient });
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
    return;
  }

  if (args.includes("--help") || args.includes("-h") || command === "help") {
    console.log(USAGE.trimEnd());
    return;
  }

  if (args.includes("--version") || args.includes("-v") || command === "version") {
    const pkg = readPackageInfo();
    console.log(pkg.version);
    return;
  }

  if (command === "start" || command === "bridge") {
    const options = parseStartOptions(command === args[0] ? args.slice(1) : args);
    startLocalProfile(options);
    return;
  }

  if (command === "web") {
    startWebSingleProfile(parseStartOptions(args.slice(1)));
    return;
  }

  if (command === "app") {
    await runAppBuilderCli(args.slice(1));
    return;
  }

  if (command === "employee") {
    await runEmployeeCli(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  console.error(USAGE.trimEnd());
  process.exitCode = 1;
}

function parseStartOptions(args: string[]): { host?: string; port?: number } {
  const options: { host?: string; port?: number } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--host") {
      options.host = readRequiredValue(args, index, "--host");
      index += 1;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--port") {
      options.port = parsePort(readRequiredValue(args, index, "--port"));
      index += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
    } else {
      throw new Error(`Unknown start option: ${arg}`);
    }
  }

  return options;
}

function readRequiredValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function readPackageInfo(): PackageInfo {
  const raw = readFileSync(join(packageRoot(), "package.json"), "utf8");
  const parsed = JSON.parse(raw) as Partial<PackageInfo>;
  return {
    name: parsed.name || "opengrove",
    version: parsed.version || "0.0.0",
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
