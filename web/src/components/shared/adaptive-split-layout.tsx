import { Tabs } from "@base-ui/react/tabs";
import { CircleAlert } from "lucide-react";
import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { UnreadCount } from "../ui/unread-count";
import { useI18n } from "../../i18n";
import styles from "./adaptive-split-layout.module.css";

const PaneVisibleContext = createContext(true);
const CompactSplitContext = createContext(false);
export const usePaneVisible = () => useContext(PaneVisibleContext);
export const useSplitCompact = () => useContext(CompactSplitContext);
export type WorkspacePane = "workspace" | "chat";

// Keep the same panels mounted in both presentations. Resizing changes placement,
// never the owner of editor drafts, iframe sessions, selection or scroll state.
export const AdaptiveSplitLayout = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div"> & {
    primary: ReactNode;
    secondary: ReactNode;
    resizeHandle?: ReactNode;
    secondaryOpen: boolean;
    primaryLabel: string;
    secondaryLabel: string;
    secondaryUnreadCount?: number;
    secondaryPendingCount?: number;
    pane: WorkspacePane;
    onPaneChange(pane: WorkspacePane): void;
  }
>(function AdaptiveSplitLayout(
  {
    primary,
    secondary,
    resizeHandle,
    secondaryOpen,
    primaryLabel,
    secondaryLabel,
    secondaryUnreadCount = 0,
    secondaryPendingCount = 0,
    pane,
    onPaneChange,
    className,
    ...props
  },
  forwardedRef,
) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const parentVisible = usePaneVisible();
  const [compact, setCompact] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      // offsetWidth is independent of the visual review canvas's CSS scale.
      if (node.offsetWidth) setCompact(node.offsetWidth < 760);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const selected = secondaryOpen ? pane : "workspace";
  const primaryVisible = parentVisible && (compact === false || selected === "workspace");
  const secondaryVisible = parentVisible && secondaryOpen && (compact === false || selected === "chat");
  return (
    <Tabs.Root
      {...props}
      ref={(node) => {
        ref.current = node;
        if (typeof forwardedRef === "function") return forwardedRef(node);
        if (forwardedRef) forwardedRef.current = node;
      }}
      value={selected}
      onValueChange={(value) => {
        if (value === "workspace" || value === "chat") onPaneChange(value);
      }}
      className={clsx("adaptive-split-layout", styles.root, className)}
      data-compact={compact ? "true" : "false"}
    >
      <Tabs.List
        activateOnFocus
        className={clsx("adaptive-pane-tabs", styles.tabs)}
        hidden={!compact || !secondaryOpen}
        aria-label={t("compact.panes", { primary: primaryLabel, secondary: secondaryLabel })}
      >
        <Tabs.Tab value="workspace">{primaryLabel}</Tabs.Tab>
        <Tabs.Tab
          value="chat"
          aria-label={[
            secondaryUnreadCount
              ? t("app.unreadCount", { label: secondaryLabel, count: secondaryUnreadCount })
              : secondaryLabel,
            secondaryPendingCount ? t("shell.pendingReplyCount", { count: secondaryPendingCount }) : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {secondaryLabel}
          <UnreadCount count={secondaryUnreadCount} />
          {secondaryPendingCount > 0 ? (
            <span
              className={styles.pending}
              title={t("shell.pendingReplyCount", { count: secondaryPendingCount })}
              aria-hidden="true"
            >
              <CircleAlert size={16} />
              {secondaryPendingCount}
            </span>
          ) : null}
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel
        keepMounted
        value="workspace"
        className={clsx("adaptive-primary-pane", styles.primary)}
        hidden={!primaryVisible}
        inert={!primaryVisible}
        role={compact ? "tabpanel" : "region"}
        aria-label={primaryLabel}
        tabIndex={compact ? 0 : -1}
      >
        <CompactSplitContext.Provider value={compact === true}>
          <PaneVisibleContext.Provider value={primaryVisible}>{primary}</PaneVisibleContext.Provider>
        </CompactSplitContext.Provider>
      </Tabs.Panel>
      {!compact && secondaryOpen ? resizeHandle : null}
      <Tabs.Panel
        keepMounted
        value="chat"
        className={clsx("adaptive-secondary-pane", styles.secondary)}
        hidden={!secondaryVisible}
        inert={!secondaryVisible}
        role={compact ? "tabpanel" : "region"}
        aria-label={secondaryLabel}
        tabIndex={compact ? 0 : -1}
      >
        <CompactSplitContext.Provider value={compact === true}>
          <PaneVisibleContext.Provider value={secondaryVisible}>{secondary}</PaneVisibleContext.Provider>
        </CompactSplitContext.Provider>
      </Tabs.Panel>
    </Tabs.Root>
  );
});
