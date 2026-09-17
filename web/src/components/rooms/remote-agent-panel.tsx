import { useNetworkAuthorization } from "./use-network-authorization";
import { useEffect, useState } from "react";
import { remoteAgentErrorText } from "./remote-agent-errors";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { openGroveClient } from "../../opengrove-client";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { useToast } from "../ui/toast";
import styles from "./remote-agent-panel.module.css";

export function RemoteAgentDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdded(memberId: string): Promise<void>;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const network = useNetworkAuthorization();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (props.open) {
      setAddress("");
      setName("");
      setError("");
    }
  }, [props.open]);
  const add = async () => {
    let memberId: string;
    setBusy(true);
    setError("");
    try {
      await network.connect();
      const result = await openGroveClient.network.contact.add({
        address: address.trim(),
        name: name.trim() || undefined,
      });
      memberId = result.memberId;
      props.onOpenChange(false);
      setAddress("");
      setName("");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError(remoteAgentErrorText(error, t, t("remoteAgent.addError")));
      return;
    } finally {
      setBusy(false);
    }
    try {
      await props.onAdded(memberId);
    } catch (error) {
      toast({
        title: t("remoteAgent.refreshError"),
        description: rawDiagnosticText(error instanceof Error ? error.message : String(error ?? "")),
        kind: "error",
      });
    }
  };
  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className={styles["remote-agent-dialog"]}>
          <DialogTitle>{t("remoteAgent.add")}</DialogTitle>
          <p className={styles["remote-agent-muted"]}>{t("remoteAgent.addHint")}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <label>
              {t("remoteAgent.address")}
              <input
                maxLength={512}
                value={address}
                placeholder={t("remoteAgent.addressExample")}
                disabled={busy}
                onChange={(event) => setAddress(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </label>
            <label>
              {t("remoteAgent.name")}
              <input maxLength={80} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
            </label>
            {error ? (
              <p role="alert" className={styles["remote-agent-error"]}>
                {error}
              </p>
            ) : null}
            <div className={styles["remote-agent-actions"]}>
              <button className="ghost-button" type="button" disabled={busy} onClick={() => props.onOpenChange(false)}>
                {t("common.cancel")}
              </button>
              <button className="primary-button" type="submit" disabled={busy || !address.trim()}>
                {busy ? t("remoteAgent.connecting") : t("remoteAgent.add")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
