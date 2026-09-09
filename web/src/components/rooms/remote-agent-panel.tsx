import { useState } from "react";
import { useI18n } from "../../i18n";
import { openGroveClient } from "../../opengrove-client";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { RoomMemberAvatar } from "./member-avatar";
import type { RoomMember } from "./rooms-model";
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

export function RemoteAgentDetail(props: {
  member: RoomMember;
  onMessage(): void;
  onNewConversation(): void;
  onDelete(): void;
}) {
  const { t } = useI18n();
  const binding = props.member.remoteAgent;
  return (
    <section className={styles["remote-agent-detail"]}>
      <span className={styles["remote-agent-badge"]}>{t("remoteAgent.remote")}</span>
      <RoomMemberAvatar member={props.member} />
      <h2>{props.member.name}</h2>
      <p className={styles["remote-agent-address"]}>{binding?.address}</p>
      <p className={styles["remote-agent-muted"]}>{t("remoteAgent.description")}</p>
      <dl>
        <dt>{t("remoteAgent.account")}</dt>
        <dd>{binding?.owner}</dd>
        <dt>{t("remoteAgent.execution")}</dt>
        <dd>{t("remoteAgent.remoteExecution")}</dd>
      </dl>
      <div className={styles["remote-agent-actions"]}>
        <button type="button" className="primary-button" onClick={props.onMessage}>
          {t("remoteAgent.message")}
        </button>
        <button type="button" className="ghost-button" onClick={props.onNewConversation}>
          {t("remoteAgent.newConversation")}
        </button>
        <button type="button" className="ghost-button" onClick={props.onDelete}>
          {t("common.remove")}
        </button>
      </div>
    </section>
  );
}
