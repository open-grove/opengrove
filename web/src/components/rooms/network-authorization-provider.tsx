import { useEffect, useRef, useState, type ReactNode } from "react";
import { openGroveClient } from "../../opengrove-client";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { NetworkAuthorizationContext } from "./use-network-authorization";
import { remoteAgentErrorText } from "./remote-agent-errors";
import styles from "./remote-agent-panel.module.css";

interface PendingAuthorization {
  controller: AbortController;
  promise: Promise<void>;
  authorizationId?: string;
  canceling?: Promise<void>;
}

function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 2000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function NetworkAuthorizationProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const pending = useRef<PendingAuthorization | undefined>(undefined);
  const [url, setUrl] = useState("");
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState(false);

  useEffect(
    () => () => {
      const operation = pending.current;
      operation?.controller.abort();
      if (operation?.authorizationId)
        void openGroveClient.network.account
          .cancel({ authorizationId: operation.authorizationId }, { signal: AbortSignal.timeout(5000) })
          .catch(() => console.warn("remote_authorization_cancel_unavailable"));
    },
    [],
  );

  const cancel = () => {
    const operation = pending.current;
    if (!operation?.authorizationId || operation.canceling) return;
    setCanceling(true);
    setCancelError(false);
    operation.canceling = openGroveClient.network.account
      .cancel({ authorizationId: operation.authorizationId }, { signal: AbortSignal.timeout(5000) })
      .then(() => {
        operation.controller.abort();
      })
      .catch(() => {
        setCancelError(true);
      })
      .finally(() => {
        operation.canceling = undefined;
        setCanceling(false);
      });
  };

  const connect = (): Promise<void> => {
    if (pending.current) return pending.current.promise;
    const controller = new AbortController();
    const operation: PendingAuthorization = { controller, promise: Promise.resolve() };
    pending.current = operation;
    operation.promise = (async () => {
      try {
        const result = await openGroveClient.network.account.connect({ signal: AbortSignal.timeout(45_000) });
        if ("account" in result) {
          controller.signal.throwIfAborted();
          return;
        }
        operation.authorizationId = result.authorizationId;
        if (controller.signal.aborted) {
          await openGroveClient.network.account.cancel({ authorizationId: result.authorizationId });
          controller.signal.throwIfAborted();
        }
        setCancelError(false);
        setUrl(result.authorizationUrl);
        while (Date.now() < result.expiresAt) {
          await pause(controller.signal);
          const status = await openGroveClient.network.account.authorization(
            { authorizationId: result.authorizationId },
            { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) },
          );
          await operation.canceling;
          controller.signal.throwIfAborted();
          if (status.status === "canceled") throw new DOMException("Authorization canceled", "AbortError");
          if (status.status === "failed") throw new Error(status.error ?? "remote_authorization_failed");
          if (status.status === "authorized") {
            const connected = await openGroveClient.network.account.connect({ signal: controller.signal });
            if (!("account" in connected)) throw new Error("remote_authorization_failed");
            return;
          }
        }
        await openGroveClient.network.account.cancel({ authorizationId: result.authorizationId });
        throw new Error("remote_authorization_expired");
      } catch (error) {
        if (operation.authorizationId && !(error instanceof DOMException && error.name === "AbortError"))
          toast({
            kind: "error",
            title: t("remoteAgent.authorizationError"),
            description: remoteAgentErrorText(
              error,
              t,
              rawDiagnosticText(error instanceof Error ? error.message : String(error)),
            ),
          });
        throw error;
      } finally {
        if (pending.current === operation) {
          pending.current = undefined;
          setUrl("");
        }
      }
    })();
    return operation.promise;
  };

  return (
    <NetworkAuthorizationContext.Provider value={{ connect }}>
      {children}
      <Dialog
        open={Boolean(url)}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <DialogContent className={styles["remote-agent-dialog"]}>
          <DialogTitle>{t("remoteAgent.authorizeTitle")}</DialogTitle>
          <p>{t("remoteAgent.authorizeHint")}</p>
          <a className="primary-button" href={url || undefined} target="_blank" rel="noopener noreferrer">
            {t("remoteAgent.authorizeOpen")}
          </a>
          <p className={styles["remote-agent-muted"]}>{t("remoteAgent.authorizeWaiting")}</p>
          {cancelError ? <p role="alert">{t("remoteAgent.cancelAuthorizationError")}</p> : null}
          <button className="ghost-button" type="button" disabled={canceling} onClick={cancel}>
            {t("common.cancel")}
          </button>
        </DialogContent>
      </Dialog>
    </NetworkAuthorizationContext.Provider>
  );
}
