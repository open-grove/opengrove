import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { Button } from "./button";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import "./confirm-dialog.css";

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  alternateLabel?: string;
  danger?: boolean;
  alternateDanger?: boolean;
}

export type ConfirmResult = "primary" | "alternate" | null;
export type ConfirmFn = (options: ConfirmOptions) => Promise<ConfirmResult>;

type PendingConfirm = ConfirmOptions & {
  resolve(result: ConfirmResult): void;
};

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<ConfirmResult>((resolve) => {
      const previous = pendingRef.current;
      const next = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
      previous?.resolve(null);
    });
  }, []);

  const settle = (result: ConfirmResult) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(result);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) settle(null);
        }}
      >
        <DialogContent className="confirm-dialog" aria-describedby={pending?.body ? "confirm-dialog-body" : undefined}>
          <DialogTitle>{pending?.title}</DialogTitle>
          {pending?.body ? (
            <p className="confirm-dialog-body" id="confirm-dialog-body">
              {pending.body}
            </p>
          ) : null}
          <div className="modal-actions">
            <Button onClick={() => settle(null)}>{pending?.cancelLabel ?? t("common.cancel")}</Button>
            {pending?.alternateLabel ? (
              pending.alternateDanger ? (
                <button
                  type="button"
                  className="danger-button confirm-dialog-alternate"
                  onClick={() => settle("alternate")}
                >
                  {pending.alternateLabel}
                </button>
              ) : (
                <Button className="confirm-dialog-alternate" onClick={() => settle("alternate")}>
                  {pending.alternateLabel}
                </Button>
              )
            ) : null}
            {pending?.danger ? (
              <button type="button" className="danger-button" onClick={() => settle("primary")}>
                {pending.confirmLabel ?? t("common.confirm")}
              </button>
            ) : (
              <Button variant="primary" onClick={() => settle("primary")}>
                {pending?.confirmLabel ?? t("common.confirm")}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return confirm;
}
