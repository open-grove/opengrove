import type { ClientUpdateResponse } from "./bridge";
import type { OpenGroveDesktopClientUpdateState } from "./desktop-api";
import { translate } from "./i18n";

export interface TitlebarClientUpdatePresentation {
  visible: boolean;
  downloadUrl?: string;
  releaseNotes?: string;
}

export interface TitlebarClientUpdateAction {
  kind: "install" | "manual-download" | "none";
  busy: boolean;
  disabled: boolean;
  label: string;
  message: string;
}

export function nextClientUpdateMetadataRefreshRelease(
  desktopState: OpenGroveDesktopClientUpdateState,
  lastRefreshedRelease: number | undefined,
): number | undefined {
  const release = desktopState.latestReleaseNumber;
  return desktopState.updateAvailable && typeof release === "number" && release !== lastRefreshedRelease
    ? release
    : undefined;
}

const VISIBLE_DESKTOP_STAGES = new Set<OpenGroveDesktopClientUpdateState["stage"]>([
  "available",
  "downloading",
  "downloaded",
  "installing",
]);

export function resolveTitlebarClientUpdate(
  update: ClientUpdateResponse | undefined,
  desktopState: OpenGroveDesktopClientUpdateState | undefined,
): TitlebarClientUpdatePresentation {
  const latest = update?.latest;
  const current = update?.current;
  const remoteUpdateAvailable = Boolean(latest && typeof current === "number" && latest.version > current);
  const desktopUpdateAvailable = Boolean(
    desktopState?.supported && (desktopState.updateAvailable || VISIBLE_DESKTOP_STAGES.has(desktopState.stage)),
  );

  return {
    visible: remoteUpdateAvailable || desktopUpdateAvailable,
    downloadUrl: desktopState?.downloadUrl || latest?.downloadUrl || undefined,
    releaseNotes: latest?.releaseNotes,
  };
}

export function resolveTitlebarClientUpdateAction(
  presentation: TitlebarClientUpdatePresentation,
  desktopState: OpenGroveDesktopClientUpdateState | undefined,
): TitlebarClientUpdateAction {
  const stage = desktopState?.stage;
  const message = localizedDesktopClientUpdateMessage(desktopState);
  if (stage === "downloaded") {
    return { kind: "install", busy: false, disabled: false, label: translate("update.installRestart"), message };
  }
  if (stage === "checking" || stage === "downloading" || stage === "installing") {
    const label =
      stage === "checking"
        ? translate("update.checking")
        : stage === "downloading"
          ? translate("update.downloading")
          : translate("update.installing");
    return { kind: "none", busy: true, disabled: true, label, message };
  }
  const manualDownload =
    Boolean(presentation.downloadUrl) &&
    (!desktopState?.supported || stage === "error" || (stage === "available" && !desktopState.canAutoInstall));
  if (manualDownload) {
    return {
      kind: "manual-download",
      busy: false,
      disabled: false,
      label: stage === "error" ? translate("update.autoFailedManual") : translate("update.manualDownload"),
      message,
    };
  }
  return { kind: "none", busy: false, disabled: true, label: translate("update.availableShort"), message };
}

function localizedDesktopClientUpdateMessage(state: OpenGroveDesktopClientUpdateState | undefined): string {
  if (!state) return translate("update.available");
  if (state.stage === "checking") return translate("update.checking");
  if (state.stage === "downloading") return translate("update.downloading");
  if (state.stage === "downloaded") {
    return translate("update.downloaded", { version: state.latestVersion || state.latestReleaseNumber || "" });
  }
  if (state.stage === "installing") return translate("update.installing");
  if (state.stage === "error") return translate("update.autoFailed");
  return translate("update.available");
}
