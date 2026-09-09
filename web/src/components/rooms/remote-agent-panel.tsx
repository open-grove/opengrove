import { useState } from "react";
import { OpenGroveClientError } from "@opengrove/client";
import { useI18n } from "../../i18n";
import { openGroveClient } from "../../opengrove-client";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import styles from "./remote-agent-panel.module.css";

export function RemoteAgentDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdded(memberId: string): Promise<void>;
}) {
  const { t } = useI18n();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await openGroveClient.network.contact.add({
        address: address.trim(),
        name: name.trim() || undefined,
      });
      await props.onAdded(result.memberId);
      props.onOpenChange(false);
      setAddress("");
      setName("");
    } catch (error) {
      const code = error instanceof OpenGroveClientError ? (error.code ?? error.message) : undefined;
      setError(
        code === "not_authenticated" || code === "external_session_invalid"
          ? t("remoteAgent.loginRequired")
          : code === "external_role_required"
            ? t("remoteAgent.adminRequired")
            : code === "remote_not_configured" || code === "invalid_service_url"
              ? t("remoteAgent.notConfigured")
              : code === "invalid_agent_address"
                ? t("remoteAgent.invalidAddress")
                : code === "remote_account_changed"
                  ? t("remoteAgent.accountChanged")
                  : t("remoteAgent.addError"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
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
            <input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
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
  );
}
