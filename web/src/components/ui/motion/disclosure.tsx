import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { motion, MotionConfig, useReducedMotion, type Transition, type Variant, type Variants } from "motion/react";
import clsx from "clsx";

// Adapted from Motion Primitives' MIT-licensed Disclosure component.
// OpenGrove keeps the component behavior and Motion variants while styling it
// through the product's existing CSS tokens rather than Tailwind classes.

type DisclosureContextValue = {
  open: boolean;
  toggle(): void;
  variants?: { expanded: Variant; collapsed: Variant };
};

const DisclosureContext = createContext<DisclosureContextValue | undefined>(undefined);
const DEFAULT_LONG_CONTENT_THRESHOLD = 480;

export const DISCLOSURE_MOTION_SETTLED_EVENT = "opengrove:disclosure-motion-settled";

function useMotionDisclosure(): DisclosureContextValue {
  const context = useContext(DisclosureContext);
  if (!context) {
    throw new Error("MotionDisclosure components must be used within MotionDisclosure");
  }
  return context;
}

export function MotionDisclosure(
  props: {
    open?: boolean;
    onOpenChange?(open: boolean): void;
    children: ReactNode;
    variants?: { expanded: Variant; collapsed: Variant };
    transition?: Transition;
  } & Omit<ComponentPropsWithoutRef<"div">, "onChange">,
) {
  const reduceMotion = useReducedMotion();
  const [internalOpen, setInternalOpen] = useState(props.open ?? false);
  const { open, onOpenChange, children, variants, transition, ...containerProps } = props;

  useEffect(() => {
    setInternalOpen(open ?? false);
  }, [open]);

  const resolvedOpen = open ?? internalOpen;
  const toggle = () => {
    const nextOpen = !resolvedOpen;
    if (open === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  return (
    <MotionConfig transition={reduceMotion ? { duration: 0 } : transition}>
      <DisclosureContext.Provider value={{ open: resolvedOpen, toggle, variants }}>
        <div {...containerProps}>{children}</div>
      </DisclosureContext.Provider>
    </MotionConfig>
  );
}

export function MotionDisclosureTrigger(props: { children: ReactNode; className?: string }) {
  const { open, toggle } = useMotionDisclosure();
  return (
    <>
      {Children.map(props.children, (child) => {
        if (!isValidElement(child)) return child;
        const element = child as ReactElement<{
          "aria-expanded"?: boolean;
          className?: string;
          onClick?(event: MouseEvent): void;
          onKeyDown?(event: KeyboardEvent): void;
        }>;
        return cloneElement(element, {
          className: clsx(props.className, element.props.className),
          "aria-expanded": open,
          onClick: (event: MouseEvent) => {
            element.props.onClick?.(event);
            if (!event.defaultPrevented) toggle();
          },
          onKeyDown: (event: KeyboardEvent) => {
            element.props.onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.key === "Enter" || event.key === " ") {
              // Prevent the native button click so keyboard activation toggles once.
              event.preventDefault();
              toggle();
            }
          },
        });
      })}
    </>
  );
}

export function MotionDisclosureContent(props: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  longContentThreshold?: number;
}) {
  const { open, variants } = useMotionDisclosure();
  const reduceMotion = useReducedMotion();
  const uniqueId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const initiallyOpen = useRef(open).current;
  const [hasOpened, setHasOpened] = useState(open);
  const [motionMode, setMotionMode] = useState<"measure" | "height" | "fade">("measure");
  const shouldRender = open || hasOpened;
  const longContentThreshold = props.longContentThreshold ?? DEFAULT_LONG_CONTENT_THRESHOLD;
  const baseVariants: Variants = {
    expanded:
      motionMode === "fade"
        ? {
            display: "block",
            height: "auto",
            opacity: 1,
            y: 0,
            pointerEvents: "auto",
            transition: reduceMotion
              ? { duration: 0 }
              : {
                  duration: 0.12,
                  ease: [0, 0, 0.2, 1],
                  height: { duration: 0 },
                },
          }
        : {
            display: "block",
            height: "auto",
            opacity: 1,
            pointerEvents: "auto",
          },
    collapsed:
      motionMode === "fade"
        ? {
            display: "block",
            height: "auto",
            opacity: 0,
            y: 4,
            pointerEvents: "none",
            transition: reduceMotion
              ? { duration: 0 }
              : {
                  duration: 0.1,
                  ease: [0.4, 0, 1, 1],
                  height: { duration: 0 },
                },
            transitionEnd: { display: "none" },
          }
        : {
            display: "block",
            height: 0,
            opacity: 0,
            pointerEvents: "none",
            transitionEnd: { display: "none" },
          },
  };
  const combinedVariants = {
    expanded: { ...baseVariants.expanded, ...variants?.expanded },
    collapsed: { ...baseVariants.collapsed, ...variants?.collapsed },
    measuring: {
      display: "block",
      height: 0,
      opacity: 0,
      pointerEvents: "none",
      transition: { duration: 0 },
    },
  };

  useEffect(() => {
    if (open) setHasOpened(true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || motionMode === "fade") return;
    const content = contentRef.current;
    if (!content) return;
    const updateMode = (contentHeight: number) => {
      const nextMode = contentHeight > longContentThreshold ? "fade" : "height";
      // Long mode is intentionally sticky: once a large subtree avoids height
      // animation, later content churn must not opt it back into layout-heavy motion.
      setMotionMode((current) => (current === "fade" || current === nextMode ? current : nextMode));
    };
    updateMode(content.scrollHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const borderBoxSize = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
      updateMode(borderBoxSize?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [longContentThreshold, motionMode, open]);

  // This attribute is mutated imperatively so message-toolbar observers can
  // skip layout reads without scheduling React renders for animation lifecycle.
  const markMotionState = (animating: boolean) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.dataset.animating = animating ? "true" : "false";
    if (!animating) {
      panel.dispatchEvent(new CustomEvent(DISCLOSURE_MOTION_SETTLED_EVENT, { bubbles: true }));
    }
  };

  return (
    <div ref={panelRef} className={props.className} data-motion-mode={motionMode}>
      {shouldRender ? (
        <motion.div
          id={uniqueId}
          className="og-disclosure-panel-motion"
          initial={initiallyOpen ? false : "collapsed"}
          animate={open ? (motionMode === "measure" && !initiallyOpen ? "measuring" : "expanded") : "collapsed"}
          aria-hidden={!open}
          inert={!open}
          variants={combinedVariants}
          onAnimationStart={() => markMotionState(true)}
          onAnimationComplete={() => markMotionState(false)}
        >
          <div ref={contentRef} className={props.contentClassName}>
            {props.children}
          </div>
        </motion.div>
      ) : null}
    </div>
  );
}
