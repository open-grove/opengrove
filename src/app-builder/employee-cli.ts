import { resolve } from "node:path";
import { createBridgeState } from "../server/bridge-state.js";
import { packEmployeeFromState } from "./employee-packager.js";

const USAGE = `OpenGrove Employee tools

Usage:
  opengrove employee pack <memberId> [--output FILE] [--state PATH] [--publisher NAME] [--title TITLE] [--summary TEXT] [--category NAME]

Commands:
  pack  Package one contact/employee from Rooms into a publishable employee package.
`;

export async function runEmployeeCli(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE.trimEnd());
    return;
  }
  if (command !== "pack") {
    throw new Error(`Unknown employee command: ${command}`);
  }
  const memberId = args[1];
  if (!memberId) throw new Error("opengrove employee pack requires <memberId>");
  const options = parsePackOptions(args.slice(2), memberId);
  const state = createBridgeState({ statePath: options.statePath });
  let result;
  try {
    result = packEmployeeFromState({
      memberId,
      state,
      outputPath: options.outputPath,
      publisher: options.publisher,
      title: options.title,
      summary: options.summary,
      category: options.category,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("employee_member_not_found:")) {
      throw new Error(`${message}. Check that --state points at the bridge state file containing this Rooms employee.`);
    }
    throw error;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        archivePath: result.archivePath,
        archiveSha256: result.archiveSha256,
        manifest: result.manifest,
        warnings: result.warnings,
      },
      null,
      2,
    ),
  );
}

function parsePackOptions(
  args: string[],
  memberId: string,
): {
  outputPath: string;
  statePath?: string;
  publisher?: string;
  title?: string;
  summary?: string;
  category?: string;
} {
  const options: {
    outputPath?: string;
    statePath?: string;
    publisher?: string;
    title?: string;
    summary?: string;
    category?: string;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--output" || arg === "-o") {
      options.outputPath = readRequiredValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--output=")) {
      options.outputPath = arg.slice("--output=".length);
    } else if (arg === "--state") {
      options.statePath = readRequiredValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--state=")) {
      options.statePath = arg.slice("--state=".length);
    } else if (arg === "--publisher") {
      options.publisher = readRequiredValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--publisher=")) {
      options.publisher = arg.slice("--publisher=".length);
    } else if (arg === "--title") {
      options.title = readRequiredValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--title=")) {
      options.title = arg.slice("--title=".length);
    } else if (arg === "--summary") {
      options.summary = readRequiredValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--summary=")) {
      options.summary = arg.slice("--summary=".length);
    } else if (arg === "--category") {
      options.category = readRequiredValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--category=")) {
      options.category = arg.slice("--category=".length);
    } else {
      throw new Error(`Unknown employee pack option: ${arg}`);
    }
  }
  return {
    outputPath: resolve(options.outputPath || `${memberId}.employee.tgz`),
    ...(options.statePath ? { statePath: options.statePath } : {}),
    ...(options.publisher ? { publisher: options.publisher } : {}),
    ...(options.title ? { title: options.title } : {}),
    ...(options.summary ? { summary: options.summary } : {}),
    ...(options.category ? { category: options.category } : {}),
  };
}

function readRequiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
