import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { useI18n } from "../../i18n";
import "./toast.css";

export type ToastKind = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastInput {
  kind: ToastKind;
  title: string;
  description?: string;
  action?: ToastAction;
  duration?: number;
}

export type ToastFn = (input: ToastInput) => void;

interface ToastRecord extends ToastInput {
  id: number;
}

interface ToastContextValue {
  toast: ToastFn;
  dismissToast(id: number): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4_500,
  info: 4_500,
  error: 8_000,
};

const MAX_VISIBLE_TOASTS = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback<ToastFn>(
    (input) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      setToasts((current) => [...current.slice(-(MAX_VISIBLE_TOASTS - 1)), { ...input, id }]);
      const duration = input.duration ?? DEFAULT_DURATION[input.kind];
      if (duration > 0) {
        timersRef.current.set(
          id,
          window.setTimeout(() => dismissToast(id), duration),
        );
      }
    },
    [dismissToast],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toast, dismissToast }), [toast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-viewport" role="region" aria-label={t("toast.regionLabel")}>
          {toasts.map((item) => (
            <div
              key={item.id}
              className="toast"
              data-kind={item.kind}
              role={item.kind === "error" ? "alert" : "status"}
            >
              <ToastIcon kind={item.kind} />
              <div className="toast-content">
                <p className="toast-title">{item.title}</p>
                {item.description ? <p className="toast-description">{item.description}</p> : null}
                {item.action ? (
                  <button
                    type="button"
                    className="toast-action"
                    onClick={() => {
                      item.action?.onClick();
                      dismissToast(item.id);
                    }}
                  >
                    {item.action.label}
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className="toast-close"
                aria-label={t("toast.close")}
                onClick={() => dismissToast(item.id)}
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === "success") return <CheckCircle2 className="toast-icon" size={17} aria-hidden />;
  if (kind === "error") return <TriangleAlert className="toast-icon" size={17} aria-hidden />;
  return <Info className="toast-icon" size={17} aria-hidden />;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function useOptionalToast(): ToastContextValue | undefined {
  return useContext(ToastContext) ?? undefined;
}
