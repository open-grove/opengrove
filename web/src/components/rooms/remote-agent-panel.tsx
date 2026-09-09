import { useState } from "react";
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
  const [profile, setProfile] = useState("");
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [account, setAccount] = useState<{ owner: string; address: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      setAccount((await openGroveClient.network.account.inspect({ profile: profile.trim() })).account);
    } catch {
      setError(t("remoteAgent.connectionError"));
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await openGroveClient.network.contact.add({
        profile: profile.trim(),
        address: address.trim(),
        name: name.trim() || undefined,
      });
      await props.onAdded(result.memberId);
      props.onOpenChange(false);
      setAddress("");
      setName("");
    } catch {
      setError(t("remoteAgent.addError"));
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
            void (account ? add() : connect());
          }}
        >
          <label>
            {t("remoteAgent.profile")}
            <input
              value={profile}
              placeholder={t("remoteAgent.profileExample")}
              disabled={busy}
              onChange={(event) => {
                setProfile(event.target.value);
                setAccount(undefined);
              }}
              autoComplete="off"
            />
          </label>
          <p className={styles["remote-agent-muted"]}>{t("remoteAgent.profileHint")}</p>
          {account ? (
            <>
              <div className={styles["remote-agent-account"]}>
                <strong>{account.owner}</strong>
                <span>{t("remoteAgent.sendAs", { address: account.address })}</span>
              </div>
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
            </>
          ) : null}
          {error ? (
            <p role="alert" className={styles["remote-agent-error"]}>
              {error}
            </p>
          ) : null}
          <div className={styles["remote-agent-actions"]}>
            <button className="ghost-button" type="button" disabled={busy} onClick={() => props.onOpenChange(false)}>
              {t("common.cancel")}
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={busy || !profile.trim() || Boolean(account && !address.trim())}
            >
              {busy ? t("remoteAgent.connecting") : account ? t("remoteAgent.add") : t("remoteAgent.connect")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
