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
    pane: WorkspacePane;
    onCompactChange?(compact: boolean): void;
  }
>(function AdaptiveSplitLayout(
  {
    primary,
    secondary,
    resizeHandle,
    secondaryOpen,
    primaryLabel,
    secondaryLabel,
    pane,
    onCompactChange,
    className,
    ...props
  },
  forwardedRef,
) {
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
  useLayoutEffect(() => {
    if (compact !== null) onCompactChange?.(compact);
  }, [compact, onCompactChange]);
  // Compact presentation is independent of the persisted desktop split preference.
  const secondaryVisible =
    parentVisible && Boolean(secondary) && (compact === false ? secondaryOpen : compact === true && pane === "chat");
  const primaryVisible = parentVisible && (compact === false || !secondaryVisible);
  return (
    <div
      {...props}
      ref={(node) => {
        ref.current = node;
        if (typeof forwardedRef === "function") return forwardedRef(node);
        if (forwardedRef) forwardedRef.current = node;
      }}
      className={clsx("adaptive-split-layout", styles.root, className)}
      data-compact={compact ? "true" : "false"}
    >
      <section
        className={clsx("adaptive-primary-pane", styles.primary)}
        hidden={!primaryVisible}
        inert={!primaryVisible}
        aria-label={primaryLabel}
      >
        <CompactSplitContext.Provider value={compact === true}>
          <PaneVisibleContext.Provider value={primaryVisible}>{primary}</PaneVisibleContext.Provider>
        </CompactSplitContext.Provider>
      </section>
      {!compact && secondaryOpen ? resizeHandle : null}
      <section
        className={clsx("adaptive-secondary-pane", styles.secondary)}
        hidden={!secondaryVisible}
        inert={!secondaryVisible}
        aria-label={secondaryLabel}
      >
        <CompactSplitContext.Provider value={compact === true}>
          <PaneVisibleContext.Provider value={secondaryVisible}>{secondary}</PaneVisibleContext.Provider>
        </CompactSplitContext.Provider>
      </section>
    </div>
  );
});
