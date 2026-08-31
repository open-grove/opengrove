import { forwardRef, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";

export const WorkspaceWorkbenchLayout = forwardRef<
  HTMLDivElement,
  {
    editorTopbar?: ReactNode;
    editorBanner?: ReactNode;
    directory: ReactNode;
    directoryResizeHandle?: ReactNode;
    preview: ReactNode;
    chatResizeHandle?: ReactNode;
    chat?: ReactNode;
    chatOpen?: boolean;
    directoryCollapsed?: boolean;
    className?: string;
    style?: CSSProperties;
  }
>(function WorkspaceWorkbenchLayout(props, ref) {
  return (
    <div
      ref={ref}
      className={clsx("workspace-workbench-layout", props.className)}
      data-directory-collapsed={props.directoryCollapsed ? "true" : "false"}
      data-editor-banner={props.editorBanner ? "true" : "false"}
      data-chat={props.chat && props.chatOpen !== false ? "true" : "false"}
      style={props.style}
    >
      <div className="workspace-workbench-editor">
        {props.editorTopbar}
        {props.editorBanner ? <div className="workspace-workbench-editor-banner">{props.editorBanner}</div> : null}
        <div className="workspace-workbench-editor-body">
          {props.directory}
          {props.directoryResizeHandle}
          {props.preview}
        </div>
      </div>
      {props.chatResizeHandle}
      {props.chat}
    </div>
  );
});
