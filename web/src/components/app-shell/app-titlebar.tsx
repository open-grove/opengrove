import { Download, History, LoaderCircle, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ClientUpdateResponse } from "../../bridge";
import type { OpenGroveDesktopClientUpdateState, OpenGroveDesktopSourceUpdateState } from "../../desktop-api";
import { resolveTitlebarClientUpdate, resolveTitlebarClientUpdateAction } from "../../client-update-presentation";
import { APP_PRODUCT_NAME } from "../../identity";
import { useI18n, type TranslationFn } from "../../i18n";
import { AccountServiceStatus } from "./app-gates";
import { AppChatIcon } from "./app-chat-icon";
import { OpenGroveSaplingMark } from "../ui/opengrove-sapling-mark";
import { UnreadCountAnchor } from "../ui/unread-count";
import clsx from "clsx";

export function AppTitlebar(props: {
  desktopPlatform: string;
  desktopFullscreen: boolean;
  officialRelease: boolean | undefined;
  railVisible: boolean;
  onToggleRail(): void;
  onOpenConversations?(): void;
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
  compactChat?: boolean;
  unreadChatCount?: number;
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
          id="app-navigation-toggle"
          className="app-titlebar-control"
          type="button"
          onClick={props.onToggleRail}
          aria-controls="app-main-navigation"
          aria-expanded={props.railVisible}
          aria-label={props.railVisible ? t("shell.collapseMainNav") : t("shell.expandMainNav")}
          title={props.railVisible ? t("shell.collapseMainNav") : t("shell.expandMainNav")}
        >
          {props.railVisible ? (
            <PanelLeftClose size={16} aria-hidden="true" />
          ) : (
            <PanelLeftOpen size={16} aria-hidden="true" />
          )}
        </button>
        {props.onOpenConversations ? (
          <button
            id="app-conversations-toggle"
            className="app-titlebar-control"
            type="button"
            onClick={props.onOpenConversations}
            aria-label={t("compact.conversations")}
            title={t("compact.conversations")}
          >
            <History size={20} aria-hidden="true" />
          </button>
        ) : null}
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
        <AppChatButton
          open={props.developerModeOpen}
          compact={props.compactChat}
          unreadCount={props.unreadChatCount}
          pendingReplies={props.pendingDeveloperReplies}
          onClick={props.onToggleDeveloperMode}
        />
      ) : null}
    </header>
  );
}

export function AppChatButton(props: {
  open: boolean;
  compact?: boolean;
  unreadCount?: number;
  pendingReplies: number;
  className?: string;
  onClick(): void;
}) {
  const { t } = useI18n();
  const action = props.compact
    ? props.open
      ? t("compact.backToWorkspace")
      : t("compact.openChat")
    : props.open
      ? t("shell.exitAppDeveloperMode")
      : t("shell.enterAppDeveloperMode");
  const label = [
    props.unreadCount ? t("app.unreadCount", { label: action, count: props.unreadCount }) : action,
    props.pendingReplies > 0 ? t("shell.pendingReplyCount", { count: props.pendingReplies }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      className={clsx("app-titlebar-developer-button", props.className)}
      data-open={props.open ? "true" : "false"}
      data-compact={props.compact ? "true" : undefined}
      type="button"
      onClick={props.onClick}
      aria-pressed={props.open}
      aria-label={label}
      title={label}
    >
      <UnreadCountAnchor count={props.unreadCount ?? 0}>
        <span className="app-chat-button-face">
          <AppChatIcon open={props.open} />
        </span>
      </UnreadCountAnchor>
      {props.pendingReplies > 0 ? <span className="app-titlebar-developer-badge" aria-hidden="true" /> : null}
    </button>
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
