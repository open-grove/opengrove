import type { BaseWindow, Dialog, OpenDialogOptions } from "electron";
import { hostMessage } from "../src/localization/host-messages.js";
import type { SupportedLocale } from "../src/localization/locale-registry.js";
import type { TrustedDesktopIpcRegistrar } from "./security-policy.js";

export type DesktopDirectoryPickerResult = { status: "cancelled" } | { status: "selected"; path: string };

export function registerDesktopDirectoryPickerIpc(input: {
  handle: TrustedDesktopIpcRegistrar;
  dialog: Pick<Dialog, "showOpenDialog">;
  getParentWindow(): BaseWindow | undefined;
  getLanguage(): SupportedLocale;
}): void {
  input.handle("opengrove:desktop:choose-directory", async (): Promise<DesktopDirectoryPickerResult> => {
    const options: OpenDialogOptions = {
      title: hostMessage(input.getLanguage(), "desktop.choose_app_folder"),
      properties: ["openDirectory"],
    };
    const parentWindow = input.getParentWindow();
    const selection = parentWindow
      ? await input.dialog.showOpenDialog(parentWindow, options)
      : await input.dialog.showOpenDialog(options);
    const path = selection.filePaths[0];
    return selection.canceled || !path ? { status: "cancelled" } : { status: "selected", path };
  });
}
