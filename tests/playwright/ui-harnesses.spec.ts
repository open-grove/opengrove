import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

const harnesses = [
  {
    name: "Radix dialog remains stable",
    script: "scripts/test-web-radix-dialog.mjs",
    marker: "web-radix-dialog-harness ok",
  },
  {
    name: "Extensions UI contract",
    script: "scripts/test-web-extensions-ui.mjs",
    marker: "web-extensions-ui",
  },
  {
    name: "Settings layout contract",
    script: "scripts/test-web-settings-layout-ui.mjs",
    marker: "web-settings-layout-ui",
  },
  {
    name: "Overlay size policy",
    script: "scripts/test-web-overlay-size-policy.mjs",
    marker: "web-overlay-size-policy harness ok",
  },
  {
    name: "Native UI interactions remain composable",
    script: "scripts/test-web-native-ui-interactions.mjs",
    marker: "web-native-ui-interactions-harness ok",
  },
  {
    name: "MCP App panel stays retryable after a failed load",
    script: "scripts/test-web-mcp-app-retry.mjs",
    marker: "web-mcp-app-retry harness ok",
  },
] as const;

for (const harness of harnesses) {
  test(harness.name, async ({}, testInfo) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [harness.script], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 110_000,
    });
    await testInfo.attach("harness-output", {
      body: `${stdout}${stderr}`,
      contentType: "text/plain",
    });
    expect(stdout).toContain(harness.marker);
  });
}
