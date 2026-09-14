import { Cloud } from "lucide-react";
import { useI18n } from "../../i18n";
import { roomMemberDisplayName, type RoomMember } from "./rooms-model";
import styles from "./member-name.module.css";

type MemberNameInput = Pick<RoomMember, "name" | "displayName" | "userOverrides" | "source">;

export function RemoteAgentIndicator() {
  const { t } = useI18n();
  return (
    <span
      className={styles.remote}
      role="img"
      aria-label={t("remoteAgent.remote")}
      title={t("remoteAgent.remoteExecution")}
    >
      <Cloud aria-hidden="true" />
    </span>
  );
}

export function RoomMemberName(props: { member?: MemberNameInput; name?: string; className?: string }) {
  const name = props.name ?? (props.member ? roomMemberDisplayName(props.member) : "");
  return (
    <span className={[styles.name, props.className].filter(Boolean).join(" ")}>
      <span className={styles.text}>{name}</span>
      {props.member?.source === "remote" ? <RemoteAgentIndicator /> : null}
    </span>
  );
}
