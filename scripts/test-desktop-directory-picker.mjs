import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-desktop-directory-picker-"));
const entryPath = join(tempDir, "entry.ts");
const bundlePath = join(tempDir, "entry.cjs");
const pickerModulePath = join(projectRoot, "desktop/directory-picker.ts");
const require = createRequire(import.meta.url);

try {
  await writeFile(
    entryPath,
    `
    import assert from "node:assert/strict";
    import { registerDesktopDirectoryPickerIpc } from ${JSON.stringify(pickerModulePath)};

    export async function runDesktopDirectoryPickerHarness() {
      let handler: (() => Promise<unknown>) | undefined;
      const handle = (channel: string, candidate: () => Promise<unknown>) => {
          assert.equal(channel, "opengrove:desktop:choose-directory");
          handler = candidate;
      };
      const parentWindow = { id: 42 };
      let language = "en";
      let receivedWindow: unknown;
      let receivedOptions: unknown;
      const dialog = {
        async showOpenDialog(window: unknown, options: unknown) {
          receivedWindow = window;
          receivedOptions = options;
          return { canceled: false, filePaths: ["C:\\\\Projects\\\\demo-app"] };
        },
      };

      registerDesktopDirectoryPickerIpc({
        handle,
        dialog,
        getParentWindow: () => parentWindow,
        getLanguage: () => language,
      });
      assert.ok(handler, "the picker IPC handler must be registered");
      assert.deepEqual(await handler(), { status: "selected", path: "C:\\\\Projects\\\\demo-app" });
      assert.equal(receivedWindow, parentWindow, "the system dialog must stay attached to the OpenGrove window");
      assert.deepEqual(receivedOptions, {
        title: "Choose an App folder",
        properties: ["openDirectory"],
      });

      language = "zh-CN";
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      assert.deepEqual(await handler(), { status: "cancelled" });

      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [] });
      assert.deepEqual(await handler(), { status: "cancelled" });

      const expected = new Error("native_dialog_failed");
      dialog.showOpenDialog = async () => { throw expected; };
      await assert.rejects(handler, expected);
    }
  `,
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  await require(bundlePath).runDesktopDirectoryPickerHarness();
  console.log("desktop-directory-picker harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
