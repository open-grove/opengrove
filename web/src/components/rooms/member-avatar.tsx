import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../../i18n";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "../ui/avatar";
import { employeeAvatarSeedForMember, useEmployeeAvatarDataUri } from "../ui/employee-avatar";
import { KernelIcon } from "../ui/entity-icons";
import { AvvvatarsFallbackContent } from "../ui/name-avatar";
import { OpenGroveSaplingMark } from "../ui/opengrove-sapling-mark";
import { roomMemberDisplayName, roomMemberUsesKernelAvatar, type MemberStatus, type RoomMember } from "./rooms-model";

type MemberAvatarInput = Pick<
  RoomMember,
  | "id"
  | "employeeDefinitionId"
  | "name"
  | "displayName"
  | "userOverrides"
  | "status"
  | "color"
  | "avatarMode"
  | "avatarSeed"
  | "avatarDataUrl"
  | "source"
> &
  Partial<Pick<RoomMember, "kernel" | "appId" | "storePackageId">>;

export function RoomMemberAvatar(props: {
  member?: MemberAvatarInput;
  name?: string;
  seed?: string;
  status?: MemberStatus;
  color?: string;
  className?: string;
  showStatus?: boolean;
}) {
  const { t } = useI18n();
  const name = props.name || (props.member ? roomMemberDisplayName(props.member) : "");
  const status = props.status || props.member?.status || "idle";
  const color = props.color || props.member?.color || "#64748b";
  const avatarMode = props.member?.avatarMode ?? (props.member?.avatarDataUrl ? "upload" : "generated");
  const avatarDataUrl = props.member?.avatarDataUrl;
  const avatarWasManuallyGenerated =
    avatarMode === "generated" &&
    Boolean(
      props.member?.avatarSeed?.trim() ||
        props.member?.userOverrides?.some((field) => field === "avatarMode" || field === "avatarSeed"),
    );
  const hasAppAvatar = Boolean(props.member?.appId || props.member?.storePackageId);
  const identity = props.member ? employeeAvatarSeedForMember(props.member) : props.seed || name || "opengrove-member";
  const generatedIdentity = props.member?.avatarSeed?.trim() || identity;
  const initialsIdentity = name.trim() || identity;
  const [customAvatarFailed, setCustomAvatarFailed] = useState(false);
  const showCustomAvatar = Boolean(avatarMode === "upload" && avatarDataUrl && !customAvatarFailed);
  const useGroveMark = !showCustomAvatar && name.trim().toLowerCase() === "grove";
  const useKernelMark =
    !showCustomAvatar &&
    Boolean(props.member?.kernel && roomMemberUsesKernelAvatar({ ...props.member, kernel: props.member.kernel }));
  const shouldGenerateEmployeeAvatar =
    !useGroveMark &&
    !useKernelMark &&
    avatarMode !== "initials" &&
    (!avatarDataUrl || customAvatarFailed || avatarMode === "generated") &&
    props.member?.source !== "human" &&
    (hasAppAvatar || avatarWasManuallyGenerated);
  const generatedEmployeeAvatar = useEmployeeAvatarDataUri(generatedIdentity, shouldGenerateEmployeeAvatar);
  const imageSource = showCustomAvatar ? avatarDataUrl : generatedEmployeeAvatar;
  const showRunningStatus = props.showStatus !== false && status === "running";
  const className = [
    "rooms-avatar",
    useGroveMark ? "grove-avatar" : "",
    useKernelMark ? "kernel-avatar" : "",
    props.className,
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => setCustomAvatarFailed(false), [avatarDataUrl]);

  return (
    <Avatar
      className={className}
      data-status={showRunningStatus ? "running" : undefined}
      role="img"
      aria-label={name}
      style={{ "--room-avatar-color": color } as CSSProperties}
    >
      {imageSource ? (
        <AvatarImage
          key={imageSource}
          src={imageSource}
          alt=""
          onLoadingStatusChange={(loadingStatus) => {
            if (loadingStatus === "error" && showCustomAvatar) {
              setCustomAvatarFailed(true);
            }
          }}
        />
      ) : null}
      <AvatarFallback>
        {useGroveMark ? (
          <OpenGroveSaplingMark />
        ) : useKernelMark && props.member ? (
          <KernelIcon kernelId={props.member.kernel} size={40} />
        ) : (
          <AvvvatarsFallbackContent value={initialsIdentity} displayValue={name || "?"} initialSize={40} />
        )}
      </AvatarFallback>
      {showRunningStatus ? <AvatarBadge role="status" aria-label={t("rooms.membersRunning", { names: name })} /> : null}
    </Avatar>
  );
}
