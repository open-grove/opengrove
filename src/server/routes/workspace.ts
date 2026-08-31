import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeWorkspaceRootValue } from "../workspace-root.js";

type SendJson = (response: ServerResponse, status: number, data: unknown) => void;

export async function handleWorkspaceRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  sendJson: SendJson;
}): Promise<boolean> {
  const { request, response, url, sendJson } = options;
  if (request.method !== "POST" || url.pathname !== "/workspace/choose-directory") {
    return false;
  }

  try {
    const path = await chooseDirectory();
    if (!path) {
      sendJson(response, 200, { ok: true, cancelled: true });
      return true;
    }
    sendJson(response, 200, { ok: true, path });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

async function chooseDirectory(): Promise<string | undefined> {
  if (process.platform !== "darwin") {
    throw new Error("directory_picker_unsupported");
  }
  const script = [
    'set pickedFolder to choose folder with prompt "Choose an OpenGrove working directory"',
    "POSIX path of pickedFolder",
  ].join("\n");
  const selected = await runAppleScript(script);
  return normalizeWorkspaceRootValue(selected, undefined);
}

function runAppleScript(script: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 120_000, maxBuffer: 8192 }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout.trim());
        return;
      }
      const message = `${stderr}\n${error.message}`;
      if (message.includes("User canceled") || message.includes("-128")) {
        resolve(undefined);
        return;
      }
      reject(new Error(stderr.trim() || error.message));
    });
  });
}
