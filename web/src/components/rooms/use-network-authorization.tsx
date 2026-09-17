import { useEffect, useRef, useState } from "react";
import { openGroveClient } from "../../opengrove-client";
import { useI18n } from "../../i18n";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import styles from "./remote-agent-panel.module.css";

/** A browser link is an explicit user gesture, so popup blocking cannot strand authorization. */
export function useNetworkAuthorization() {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const pending = useRef<AbortController | undefined>(undefined);
  const cancel = () => {
    if (!pending.current) return;
    pending.current.abort();
    pending.current = undefined;
    setUrl("");
    void openGroveClient.network.account.cancel().catch(() => {
      console.warn("remote_authorization_cancel_unavailable");
    });
  };
  useEffect(
    () => () => {
      if (pending.current) {
        pending.current.abort();
        void openGroveClient.network.account.cancel().catch(() => {
          console.warn("remote_authorization_cancel_unavailable");
        });
      }
    },
    [],
  );
  const connect = async () => {
    const controller = new AbortController();
    pending.current = controller;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const result = await openGroveClient.network.account.connect();
        controller.signal.throwIfAborted();
        if ("account" in result) return;
        setUrl(result.authorizationUrl);
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(controller.signal.reason);
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 1000);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        setUrl("");
      }
    }
  };
  const prompt = (
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
        <button className="ghost-button" type="button" onClick={cancel}>
          {t("common.cancel")}
        </button>
      </DialogContent>
    </Dialog>
  );
  return { connect, prompt };
}
