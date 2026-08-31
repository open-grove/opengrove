import * as DialogPrimitive from "@radix-ui/react-dialog";
import clsx from "clsx";
import {
  useCallback,
  createContext,
  useEffect,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ProductIcon } from "./product-icon";
import "./dialog.css";

export const Dialog = DialogPrimitive.Root;
type DialogContentContextValue = {
  inside: boolean;
  subpageHost: HTMLDivElement | null;
  registerSubpage(onBack: () => void): () => void;
};

const DialogContentContext = createContext<DialogContentContextValue | null>(null);

export function useInsideDialogContent(): boolean {
  return useContext(DialogContentContext)?.inside === true;
}

export function DialogContent({
  children,
  className,
  onEscapeKeyDown,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [subpageHost, setSubpageHost] = useState<HTMLDivElement | null>(null);
  const [activeSubpage, setActiveSubpage] = useState<{ id: symbol; onBack(): void } | null>(null);
  const registerSubpage = useCallback((onBack: () => void) => {
    const id = Symbol("dialog-subpage");
    setActiveSubpage({ id, onBack });
    return () => {
      setActiveSubpage((current) => (current?.id === id ? null : current));
    };
  }, []);
  const contextValue = useMemo<DialogContentContextValue>(
    () => ({
      inside: true,
      subpageHost,
      registerSubpage,
    }),
    [registerSubpage, subpageHost],
  );

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !subpageHost || !activeSubpage) return;
    const hidden = Array.from(content.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== subpageHost)
      .map((element) => ({
        element,
        ariaHidden: element.getAttribute("aria-hidden"),
        inert: element.hasAttribute("inert"),
      }));
    for (const item of hidden) {
      item.element.setAttribute("aria-hidden", "true");
      item.element.setAttribute("inert", "");
    }
    return () => {
      for (const item of hidden) {
        if (item.ariaHidden === null) item.element.removeAttribute("aria-hidden");
        else item.element.setAttribute("aria-hidden", item.ariaHidden);
        if (!item.inert) item.element.removeAttribute("inert");
      }
    };
  }, [activeSubpage, subpageHost]);

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="modal-overlay" />
      <div className="modal-shell">
        <DialogPrimitive.Content
          ref={contentRef}
          className={clsx("modal-card", className)}
          onEscapeKeyDown={(event) => {
            onEscapeKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (activeSubpage) {
              event.preventDefault();
              activeSubpage.onBack();
              return;
            }
            const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            if (focusedElement?.closest('[data-dialog-escape-stays-open="true"]')) {
              event.preventDefault();
            }
          }}
          {...props}
        >
          <DialogContentContext.Provider value={contextValue}>
            {children}
            <div className="modal-subpage-host" ref={setSubpageHost} />
          </DialogContentContext.Provider>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={clsx("modal-title", className)} {...props} />;
}

export function DialogSubpage(props: {
  title: string;
  backLabel: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  onBack(): void;
}) {
  const dialogContext = useContext(DialogContentContext);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const onBackRef = useRef(props.onBack);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    onBackRef.current = props.onBack;
  }, [props.onBack]);
  useLayoutEffect(() => dialogContext?.registerSubpage(() => onBackRef.current()), [dialogContext]);
  useLayoutEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backButtonRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);

  const subpage = (
    <section className={clsx("modal-subpage", props.className)} aria-label={props.title}>
      <header className="modal-subpage-header">
        <button ref={backButtonRef} type="button" onClick={props.onBack} aria-label={props.backLabel}>
          <ProductIcon name="back" size={20} />
        </button>
        <h2>{props.title}</h2>
      </header>
      <div className="modal-subpage-body">{props.children}</div>
      {props.actions ? <div className="modal-subpage-actions">{props.actions}</div> : null}
    </section>
  );
  return dialogContext?.subpageHost ? createPortal(subpage, dialogContext.subpageHost) : null;
}
