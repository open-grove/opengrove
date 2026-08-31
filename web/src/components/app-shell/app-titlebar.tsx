import { Bot, Download, LoaderCircle, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ClientUpdateResponse } from "../../bridge";
import type { OpenGroveDesktopClientUpdateState, OpenGroveDesktopSourceUpdateState } from "../../desktop-api";
import { resolveTitlebarClientUpdate, resolveTitlebarClientUpdateAction } from "../../client-update-presentation";
import { APP_PRODUCT_NAME } from "../../identity";
import { useI18n, type TranslationFn } from "../../i18n";
import { AccountServiceStatus } from "./app-gates";
import { OpenGroveSaplingMark } from "../ui/opengrove-sapling-mark";

export function AppTitlebar(props: {
  desktopPlatform: string;
  desktopFullscreen: boolean;
  officialRelease: boolean | undefined;
  railExpanded: boolean;
  onToggleRail(): void;
  sourceUpdate: OpenGroveDesktopSourceUpdateState | undefined;
  onSourceUpdate(): void;
  clientUpdate: ClientUpdateResponse | undefined;
  desktopClientUpdate: OpenGroveDesktopClientUpdateState | undefined;
  onClientUpdateInstall(): void;
  accountState?: "checking" | "offline";
  accountRetrying: boolean;
  accountErrorReference?: string;
  onAccountRetry(): void;
  developerModeVisible: boolean;
  developerModeOpen: boolean;
  pendingDeveloperReplies: number;
  onToggleDeveloperMode(): void;
}) {
  const { t } = useI18n();
  return (
    <header
      className="app-titlebar"
      data-desktop-platform={props.desktopPlatform || undefined}
      data-desktop-fullscreen={props.desktopFullscreen ? "true" : undefined}
      aria-label={APP_PRODUCT_NAME}
    >
      <div className="app-titlebar-left">
        <button
          className="app-titlebar-control"
          type="button"
          onClick={props.onToggleRail}
          aria-label={props.railExpanded ? t("shell.collapseMainNav") : t("shell.expandMainNav")}
          title={props.railExpanded ? t("shell.collapseMainNav") : t("shell.expandMainNav")}
        >
          {props.railExpanded ? (
            <PanelLeftClose size={16} aria-hidden="true" />
          ) : (
            <PanelLeftOpen size={16} aria-hidden="true" />
          )}
        </button>
        <span className="app-titlebar-brand" title={APP_PRODUCT_NAME}>
          <span className="app-titlebar-brand-mark" aria-hidden="true">
            <OpenGroveSaplingMark />
          </span>
          <span className="app-titlebar-brand-word">
            Open<span>Grove</span>
          </span>
          {props.officialRelease === false ? <span className="app-titlebar-dev-badge">DEV</span> : null}
        </span>
        <TitlebarSourceUpdateButton state={props.sourceUpdate} onClick={props.onSourceUpdate} />
        <TitlebarClientUpdateButton
          update={props.clientUpdate}
          desktopState={props.desktopClientUpdate}
          onInstall={props.onClientUpdateInstall}
        />
      </div>
      <AccountServiceStatus
        state={props.accountState}
        retrying={props.accountRetrying}
        errorReference={props.accountErrorReference}
        onRetry={props.onAccountRetry}
      />
      <div className="app-titlebar-drag-space" aria-hidden="true" />
      {props.developerModeVisible ? (
        <button
          className="app-titlebar-developer-button"
          data-open={props.developerModeOpen ? "true" : "false"}
          type="button"
          onClick={props.onToggleDeveloperMode}
          aria-label={props.developerModeOpen ? t("shell.exitAppDeveloperMode") : t("shell.enterAppDeveloperMode")}
          title={props.developerModeOpen ? t("shell.exitAppDeveloperMode") : t("shell.enterAppDeveloperMode")}
        >
          <Bot size={17} aria-hidden="true" />
          {props.pendingDeveloperReplies > 0 ? (
            <span
              className="app-titlebar-developer-badge"
              aria-label={t("shell.pendingReplyCount", { count: props.pendingDeveloperReplies })}
            />
          ) : null}
        </button>
      ) : null}
    </header>
  );
}

function TitlebarSourceUpdateButton(props: { state: OpenGroveDesktopSourceUpdateState | undefined; onClick(): void }) {
  const { t } = useI18n();
  const { state } = props;
  if (!shouldShowTitlebarSourceUpdate(state)) return null;

  const busy = state.busy || state.stage === "updating" || state.stage === "restarting";
  const Icon = busy ? LoaderCircle : Download;
  const label = titlebarSourceUpdateLabel(state, t);
  const title = label;
  if (busy) return <TitlebarLongTaskStatus label={label} />;

  return (
    <button
      className="app-titlebar-update-button"
      data-busy={busy ? "true" : undefined}
      type="button"
      onClick={props.onClick}
      aria-label={label}
      title={title}
      disabled={busy}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function shouldShowTitlebarSourceUpdate(
  state: OpenGroveDesktopSourceUpdateState | undefined,
): state is OpenGroveDesktopSourceUpdateState {
  if (!state?.supported) return false;
  if (state.stage === "updating" || state.stage === "restarting") return true;
  return Boolean(state.updateAvailable && !state.worktreeDirty && state.stage !== "blocked" && state.stage !== "error");
}

function titlebarSourceUpdateLabel(state: OpenGroveDesktopSourceUpdateState, t: TranslationFn): string {
  if (state.stage === "updating") return t("shell.updateUpdating");
  if (state.stage === "restarting") return t("shell.updateRestarting");
  if (state.behind) return t("shell.updatesAvailableCount", { count: state.behind });
  return t("shell.updateAvailable");
}

function TitlebarClientUpdateButton(props: {
  update: ClientUpdateResponse | undefined;
  desktopState: OpenGroveDesktopClientUpdateState | undefined;
  onInstall(): void;
}) {
  const { t } = useI18n();
  const desktopState = props.desktopState;
  const presentation = resolveTitlebarClientUpdate(props.update, desktopState);
  if (!presentation.visible) return null;

  const action = resolveTitlebarClientUpdateAction(presentation, desktopState);
  const ready = action.kind === "install";
  const Icon = action.busy ? LoaderCircle : Download;
  const title = [
    action.message,
    desktopState?.details ? t("shell.autoUpdateDetails", { details: desktopState.details }) : "",
    desktopState?.stage === "downloading" && typeof desktopState.downloadProgress === "number"
      ? t("shell.downloadProgress", { progress: desktopState.downloadProgress })
      : "",
    presentation.releaseNotes ? t("shell.releaseNotes", { notes: presentation.releaseNotes }) : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (action.busy) {
    return (
      <TitlebarLongTaskStatus
        label={action.label}
        progress={desktopState?.stage === "downloading" ? desktopState.downloadProgress : undefined}
      />
    );
  }

  return (
    <button
      className="app-titlebar-update-button"
      type="button"
      data-busy={action.busy ? "true" : undefined}
      onClick={
        ready
          ? props.onInstall
          : action.kind === "manual-download"
            ? () => {
                if (presentation.downloadUrl) window.open(presentation.downloadUrl, "_blank", "noopener,noreferrer");
              }
            : undefined
      }
      aria-label={action.label}
      title={title}
      disabled={action.disabled}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function TitlebarLongTaskStatus(props: { label: string; progress?: number }) {
  return (
    <div className="app-titlebar-account-status-live" role="status" aria-live="polite">
      <div className="app-titlebar-account-status" data-state="task">
        <LoaderCircle size={13} aria-hidden="true" />
        <span>{props.label}</span>
        {typeof props.progress === "number" ? <small>{Math.round(props.progress)}%</small> : null}
      </div>
    </div>
  );
}
