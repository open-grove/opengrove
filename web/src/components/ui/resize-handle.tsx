import type { ComponentPropsWithRef } from "react";
import clsx from "clsx";
import "./resize-handle.css";

type ResizeHandleProps = Omit<ComponentPropsWithRef<"div">, "role" | "children"> & {
  "aria-label": string;
};

// Layouts own their geometry and width constraints; every divider shares this
// transparent hit area, cursor feedback, and separator semantics.
export function ResizeHandle({ className, ...props }: ResizeHandleProps) {
  return (
    <div
      aria-orientation="vertical"
      tabIndex={props.onKeyDown ? 0 : undefined}
      {...props}
      role="separator"
      className={clsx("resize-handle", className)}
    />
  );
}
