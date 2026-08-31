import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import {
  DISCLOSURE_MOTION_SETTLED_EVENT,
  MotionDisclosure,
  MotionDisclosureContent,
  MotionDisclosureTrigger,
} from "../ui/motion/disclosure";
import "./disclosure.css";

export { DISCLOSURE_MOTION_SETTLED_EVENT };

// Controlled-with-default open state shared by every process-area disclosure:
//   - `forceOpen` wins (e.g. a pending question must stay open),
//   - otherwise the user's explicit toggle wins,
//   - otherwise fall back to `defaultOpen`.
export function useDisclosure(options: { defaultOpen?: boolean; forceOpen?: boolean } = {}): {
  open: boolean;
  toggle(): void;
} {
  const defaultOpen = options.defaultOpen ?? false;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = options.forceOpen || (userOpen ?? defaultOpen);
  return {
    open,
    toggle: () => setUserOpen((current) => !(current ?? defaultOpen)),
  };
}

/**
 * The one collapsible "process group" primitive used across the chat surfaces
 * (assistant run timeline, room run details, exploration cluster, edit diff).
 *
 * Renders: an optional leading slot, a toggle button (summary + rotating
 * chevron), an optional trailing control, and an animated panel whose children
 * reveal with a staggered slide-up. Hierarchy/scale differences between surfaces
 * are layered on via `variant`/`className`, NOT by forking this markup.
 *
 * Motion uses the shared tokens (--dur-*, --ease-entrance) and the global
 * prefers-reduced-motion guard in reset.css disables it automatically.
 */
export function Disclosure(props: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  onToggle?(open: boolean): void;
  variant?: "process" | "room-run" | "exploration";
  active?: boolean;
  className?: string;
  summaryClassName?: string;
  panelClassName?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const controlled = props.open !== undefined;
  const internal = useDisclosure({ defaultOpen: props.defaultOpen, forceOpen: props.forceOpen });
  const open = controlled ? Boolean(props.open) : internal.open;
  const handleOpenChange = (nextOpen: boolean) => {
    if (!controlled) {
      internal.toggle();
    }
    props.onToggle?.(nextOpen);
  };

  return (
    <MotionDisclosure
      className={clsx("og-disclosure", props.variant ? `og-disclosure--${props.variant}` : null, props.className)}
      open={open}
      onOpenChange={handleOpenChange}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      data-open={open ? "true" : "false"}
      data-active={props.active ? "true" : "false"}
    >
      <div className="og-disclosure-row">
        {props.leading}
        <MotionDisclosureTrigger>
          <button type="button" className={clsx("og-disclosure-toggle", props.summaryClassName)}>
            <span className="og-disclosure-summary">{props.summary}</span>
            <ChevronRight className="og-disclosure-chevron" size={14} strokeWidth={2.1} aria-hidden="true" />
          </button>
        </MotionDisclosureTrigger>
        {props.trailing}
      </div>
      <MotionDisclosureContent
        className="og-disclosure-panel"
        contentClassName={clsx("og-disclosure-panel-inner", props.panelClassName)}
      >
        {props.children}
      </MotionDisclosureContent>
    </MotionDisclosure>
  );
}
