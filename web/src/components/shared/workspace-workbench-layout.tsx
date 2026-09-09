import { forwardRef, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CompactBackButton } from "./compact-list-detail";
import clsx from "clsx";
import { useI18n } from "../../i18n";
import { AdaptiveSplitLayout, useSplitCompact, type WorkspacePane } from "./adaptive-split-layout";

type Props = {
  editorTopbar?: ReactNode;
  editorBanner?: ReactNode;
  directory: ReactNode;
  directoryResizeHandle?: ReactNode;
  preview: ReactNode;
  chatResizeHandle?: ReactNode;
  chat?: ReactNode;
  chatOpen?: boolean;
  chatUnreadCount?: number;
  chatPendingCount?: number;
  directoryCollapsed?: boolean;
  className?: string;
  style?: CSSProperties;
  pane?: WorkspacePane;
  onPaneChange?(pane: WorkspacePane): void;
  detailOpen?: boolean;
  onOpenDirectory?(): void;
};

export const WorkspaceWorkbenchLayout = forwardRef<HTMLDivElement, Props>(
  function WorkspaceWorkbenchLayout(props, ref) {
    const { t } = useI18n();
    const [pane, setPane] = useState<WorkspacePane>("workspace");
    return (
      <AdaptiveSplitLayout
        ref={ref}
        className={clsx("workspace-workbench-layout", props.className)}
        data-directory-collapsed={props.directoryCollapsed ? "true" : "false"}
        data-editor-banner={props.editorBanner ? "true" : "false"}
        data-chat={props.chat && props.chatOpen !== false ? "true" : "false"}
        style={props.style}
        pane={props.pane ?? pane}
        onPaneChange={props.onPaneChange ?? setPane}
        primaryLabel={t("compact.workspace")}
        secondaryLabel={t("compact.chat")}
        secondaryUnreadCount={props.chatUnreadCount}
        secondaryPendingCount={props.chatPendingCount}
        secondaryOpen={Boolean(props.chat) && props.chatOpen !== false}
        primary={<WorkbenchEditor {...props} />}
        resizeHandle={props.chatResizeHandle}
        secondary={props.chat}
      />
    );
  },
);

function WorkbenchEditor(props: Props) {
  const compact = useSplitCompact();
  const { t } = useI18n();
  const detail = props.detailOpen || !props.directory;
  const previousDetail = useRef(detail);
  const directoryFocus = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const changed = previousDetail.current !== detail;
    previousDetail.current = detail;
    if (!compact || !changed) return;
    if (detail) previewRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    else if (directoryFocus.current?.isConnected) directoryFocus.current.focus({ preventScroll: true });
  }, [compact, detail]);
  return (
    <div className="workspace-workbench-editor" data-compact-detail={detail ? "true" : "false"}>
      {props.editorTopbar}
      {props.editorBanner ? <div className="workspace-workbench-editor-banner">{props.editorBanner}</div> : null}
      <div className="workspace-workbench-editor-body">
        <div
          className="workspace-directory-slot"
          hidden={compact && detail}
          inert={compact && detail}
          onClickCapture={(event) => {
            if (event.target instanceof Element)
              directoryFocus.current = event.target.closest<HTMLElement>("button, [role=button], input, [tabindex]");
          }}
          onFocusCapture={(event) => {
            directoryFocus.current = event.target;
          }}
        >
          {props.directory}
        </div>
        {compact ? null : props.directoryResizeHandle}
        <div ref={previewRef} className="workspace-preview-slot" hidden={compact && !detail} inert={compact && !detail}>
          {compact && props.directory ? (
            <CompactBackButton label={t("compact.files")} onClick={() => props.onOpenDirectory?.()} />
          ) : null}
          {props.preview}
        </div>
      </div>
    </div>
  );
}
