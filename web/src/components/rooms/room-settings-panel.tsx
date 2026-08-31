import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { ObjectSettingsRow, ObjectSettingsSection } from "../ui/object-settings";
import { ProductIcon } from "../ui/product-icon";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { RoomMemberAvatar } from "./member-avatar";
import { RoomGroupAvatar, isGroveRoomTitle } from "./room-group-avatar";
import { ROOM_OWNER_MEMBER, memberModelLabel, roomMemberDisplayName, type Room, type RoomMember } from "./rooms-model";
import "./room-members.css";

export type RoomMemberPickerMode = "add" | "remove" | null;

type RoomSettingsPanelProps = {
  activeRoom: Room;
  activeDirectMember?: RoomMember;
  memberPanelOpen: boolean;
  presentation?: "panel" | "popover";
  page: "overview" | "members";
  memberQuery: string;
  memberPickerMode: RoomMemberPickerMode;
  memberPickerQuery: string;
  memberPickerOptions: RoomMember[];
  visibleRoomMembers: RoomMember[];
  filteredMembers: RoomMember[];
  removableMembers: RoomMember[];
  visibleRoomMemberCount: number;
  onClose(): void;
  onPageChange(page: "overview" | "members"): void;
  onRenameRoom(title: string): void;
  onPinnedChange(pinned: boolean): void;
  onMemberQueryChange(value: string): void;
  onOpenMemberPicker(mode: Exclude<RoomMemberPickerMode, null>): void;
  onCloseMemberPicker(): void;
  onMemberPickerQueryChange(value: string): void;
  onAddMember(member: RoomMember): void;
  onRemoveMember(member: RoomMember): void;
  onToggleMemberAdmin(member: RoomMember): void;
  onOpenMemberProfile?(member: RoomMember): void;
  isMemberOwner?(member: RoomMember): boolean;
};

export function RoomSettingsPanel(props: RoomSettingsPanelProps) {
  const { t } = useI18n();
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  useEffect(() => {
    setTitleDraft(null);
  }, [props.activeRoom.id]);

  // 行内重命名：Enter/失焦提交，Esc 取消，空值或与原名相同不提交。
  function commitTitleDraft() {
    const nextTitle = (titleDraft ?? "").trim();
    setTitleDraft(null);
    if (!nextTitle || nextTitle === props.activeRoom.title) return;
    props.onRenameRoom(nextTitle);
  }

  return (
    <aside
      className="rooms-side-panel"
      data-open={props.memberPanelOpen ? "true" : "false"}
      data-presentation={props.presentation ?? "panel"}
      aria-label={props.activeRoom.kind === "group" ? t("rooms.groupSettings") : t("mountedApp.membersShort")}
    >
      <header className="rooms-member-drawer-header">
        {props.page === "members" ? (
          <button
            className="rooms-settings-back-button"
            type="button"
            onClick={() => {
              props.onCloseMemberPicker();
              props.onPageChange("overview");
            }}
            aria-label={t("common.back")}
          >
            <ProductIcon name="back" size={18} />
            <span>{props.activeRoom.kind === "group" ? t("rooms.groupMembers") : t("mountedApp.membersShort")}</span>
          </button>
        ) : (
          <h3>{props.activeRoom.kind === "group" ? t("common.settings") : t("mountedApp.membersShort")}</h3>
        )}
        <Tooltip content={t("mountedApp.close")} side="left">
          <button
            className="rooms-icon-button"
            type="button"
            onClick={props.onClose}
            aria-label={t("rooms.closePanel")}
          >
            <ProductIcon name="close" size={20} />
          </button>
        </Tooltip>
      </header>
      <div className="rooms-settings-scroll">
        {props.page === "overview" ? (
          <>
            <section className="rooms-group-profile-card">
              {props.activeDirectMember && props.onOpenMemberProfile && !isGroveRoomTitle(props.activeRoom.title) ? (
                <Tooltip content={t("employee.profileSettingsTitle")}>
                  <button
                    className="rooms-member-avatar-button"
                    type="button"
                    onClick={() => props.onOpenMemberProfile?.(props.activeDirectMember!)}
                    aria-label={t("employee.openSettingsFor", {
                      name: roomMemberDisplayName(props.activeDirectMember),
                    })}
                  >
                    <RoomMemberAvatar member={props.activeDirectMember} className="rooms-group-profile-icon" />
                  </button>
                </Tooltip>
              ) : (
                <RoomGroupAvatar
                  title={props.activeRoom.title}
                  className="rooms-group-profile-icon"
                  members={props.visibleRoomMembers.filter((member) => props.activeRoom.memberIds.includes(member.id))}
                />
              )}
              <div className="rooms-group-profile-copy">
                {titleDraft !== null ? (
                  <input
                    className="rooms-group-rename-input"
                    value={titleDraft}
                    autoFocus
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={commitTitleDraft}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setTitleDraft(null);
                    }}
                    aria-label={t("rooms.groupNameLabel")}
                  />
                ) : props.activeRoom.kind === "group" ? (
                  <Tooltip content={t("rooms.editName")}>
                    <button
                      className="rooms-group-profile-edit-trigger"
                      type="button"
                      onClick={() => setTitleDraft(props.activeRoom.title)}
                      aria-label={t("rooms.editName")}
                    >
                      <strong>{props.activeRoom.title}</strong>
                      <ProductIcon name="edit" size={14} />
                    </button>
                  </Tooltip>
                ) : (
                  <strong>{props.activeRoom.title}</strong>
                )}
                {props.activeRoom.kind !== "group" ? (
                  <span>
                    {props.activeDirectMember
                      ? `${props.activeDirectMember.kernel} / ${memberModelLabel(props.activeDirectMember)}`
                      : t("contacts.directBadge")}
                  </span>
                ) : null}
              </div>
            </section>

            {props.activeRoom.kind === "group" ? (
              <section className="rooms-inline-member-section">
                <header className="rooms-inline-member-header">
                  <span>
                    <strong>{t("rooms.groupMembers")}</strong>
                    <small>{props.visibleRoomMemberCount}</small>
                  </span>
                  <Tooltip content={t("rooms.addMember")}>
                    <button
                      className="rooms-member-round-action"
                      type="button"
                      onClick={() => props.onOpenMemberPicker("add")}
                      aria-expanded={props.memberPickerMode === "add"}
                      aria-label={t("rooms.addMember")}
                      data-active={props.memberPickerMode === "add" ? "true" : "false"}
                    >
                      <ProductIcon name="add" size={18} />
                    </button>
                  </Tooltip>
                </header>
                {props.memberPickerMode ? (
                  <MemberPicker
                    mode={props.memberPickerMode}
                    query={props.memberPickerQuery}
                    options={props.memberPickerOptions}
                    onQueryChange={props.onMemberPickerQueryChange}
                    onClose={props.onCloseMemberPicker}
                    onSelect={(member) => {
                      if (props.memberPickerMode === "add") props.onAddMember(member);
                      else props.onRemoveMember(member);
                    }}
                  />
                ) : null}
                <MemberRows
                  room={props.activeRoom}
                  members={props.visibleRoomMembers}
                  removableMembers={props.removableMembers}
                  isMemberOwner={props.isMemberOwner}
                  onToggleMemberAdmin={props.onToggleMemberAdmin}
                  onOpenMemberProfile={props.onOpenMemberProfile}
                  onRemoveMember={props.onRemoveMember}
                />
              </section>
            ) : null}

            <ObjectSettingsSection>
              {props.activeRoom.kind !== "group" ? (
                <ObjectSettingsRow
                  icon="contacts"
                  title={t("mountedApp.membersShort")}
                  value={props.visibleRoomMemberCount}
                  onClick={() => props.onPageChange("members")}
                />
              ) : null}
              <ObjectSettingsRow
                icon="pin"
                title={t("rooms.pinChat")}
                trailing={
                  <Switch
                    checked={Boolean(props.activeRoom.pinned)}
                    onCheckedChange={props.onPinnedChange}
                    ariaLabel={props.activeRoom.pinned ? t("rooms.unpin") : t("rooms.pin")}
                  />
                }
              />
            </ObjectSettingsSection>
          </>
        ) : (
          <>
            <div className="rooms-member-tools">
              <label className="rooms-member-search">
                <ProductIcon name="search" size={17} />
                <input
                  value={props.memberQuery}
                  onChange={(event) => props.onMemberQueryChange(event.target.value)}
                  placeholder={t("rooms.searchPlaceholder")}
                />
              </label>
              {props.activeRoom.kind === "group" ? (
                <div className="rooms-member-tool-actions">
                  <Tooltip content={t("rooms.addMember")}>
                    <button
                      className="rooms-member-round-action"
                      type="button"
                      onClick={() => props.onOpenMemberPicker("add")}
                      aria-expanded={props.memberPickerMode === "add"}
                      aria-label={t("rooms.addMember")}
                      data-active={props.memberPickerMode === "add" ? "true" : "false"}
                    >
                      <ProductIcon name="add" size={19} />
                    </button>
                  </Tooltip>
                </div>
              ) : null}
            </div>
            {props.memberPickerMode ? (
              <MemberPicker
                mode={props.memberPickerMode}
                query={props.memberPickerQuery}
                options={props.memberPickerOptions}
                onQueryChange={props.onMemberPickerQueryChange}
                onClose={props.onCloseMemberPicker}
                onSelect={(member) => {
                  if (props.memberPickerMode === "add") props.onAddMember(member);
                  else props.onRemoveMember(member);
                }}
              />
            ) : null}
            <MemberRows
              room={props.activeRoom}
              members={props.filteredMembers}
              removableMembers={props.removableMembers}
              isMemberOwner={props.isMemberOwner}
              onToggleMemberAdmin={props.onToggleMemberAdmin}
              onOpenMemberProfile={props.onOpenMemberProfile}
              onRemoveMember={props.onRemoveMember}
            />
          </>
        )}
      </div>
    </aside>
  );
}

function MemberRows(props: {
  room: Room;
  members: RoomMember[];
  removableMembers: RoomMember[];
  isMemberOwner?(member: RoomMember): boolean;
  onToggleMemberAdmin(member: RoomMember): void;
  onOpenMemberProfile?(member: RoomMember): void;
  onRemoveMember(member: RoomMember): void;
}) {
  const { t } = useI18n();
  return (
    <div className="rooms-member-drawer-list">
      {props.members.length ? (
        props.members.map((member) => {
          const displayName = roomMemberDisplayName(member);
          const owner = props.isMemberOwner?.(member) ?? member.id === ROOM_OWNER_MEMBER.id;
          const administrator = props.room.adminMemberIds.includes(member.id);
          const removable = props.removableMembers.some((candidate) => candidate.id === member.id);
          return (
            <div key={member.id} className="rooms-member-row" data-administrator={administrator ? "true" : "false"}>
              <RoomMemberAvatar member={member} className="rooms-member-mini-avatar" />
              <div className="rooms-member-row-title">
                <strong>{displayName}</strong>
                {owner ? <span>{t("rooms.groupOwner")}</span> : null}
                {administrator ? <span>{t("rooms.groupAdministrator")}</span> : null}
              </div>
              {!owner ? (
                <div className="rooms-member-row-actions">
                  <Tooltip
                    content={administrator ? t("rooms.removeAdministratorShort") : t("rooms.setAdministratorShort")}
                  >
                    <button
                      type="button"
                      data-active={administrator ? "true" : "false"}
                      onClick={() => props.onToggleMemberAdmin(member)}
                      aria-label={
                        administrator
                          ? t("rooms.removeAdministrator", { name: displayName })
                          : t("rooms.setAdministrator", { name: displayName })
                      }
                    >
                      <ProductIcon name="shield" size={17} />
                    </button>
                  </Tooltip>
                  {props.onOpenMemberProfile ? (
                    <Tooltip content={t("rooms.employeeSettings")}>
                      <button
                        type="button"
                        onClick={() => props.onOpenMemberProfile?.(member)}
                        aria-label={t("employee.openSettingsFor", { name: displayName })}
                      >
                        <ProductIcon name="settings" size={17} />
                      </button>
                    </Tooltip>
                  ) : null}
                  <Tooltip content={removable ? t("rooms.removeMember") : t("rooms.keepAtLeastOneMember")}>
                    <button
                      className="rooms-member-row-danger-action"
                      type="button"
                      onClick={() => props.onRemoveMember(member)}
                      disabled={!removable}
                      aria-label={t("rooms.removeMemberNamed", { name: displayName })}
                    >
                      <ProductIcon name="delete" size={17} />
                    </button>
                  </Tooltip>
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="rooms-empty-row">{t("rooms.noMatchingMembers")}</div>
      )}
    </div>
  );
}

function MemberPicker(props: {
  mode: Exclude<RoomMemberPickerMode, null>;
  query: string;
  options: RoomMember[];
  onQueryChange(value: string): void;
  onClose(): void;
  onSelect(member: RoomMember): void;
}) {
  const { t } = useI18n();
  return (
    <div className="rooms-member-picker">
      <div className="rooms-member-picker-head">
        <strong>{props.mode === "add" ? t("rooms.addMember") : t("rooms.removeMember")}</strong>
        <button type="button" onClick={props.onClose} aria-label={t("rooms.closeMemberPicker")}>
          <ProductIcon name="close" size={14} />
        </button>
      </div>
      <label className="rooms-member-picker-search">
        <ProductIcon name="search" size={15} />
        <input
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder={props.mode === "add" ? t("rooms.searchAddableMembers") : t("rooms.searchRemovableMembers")}
        />
      </label>
      <div className="rooms-member-picker-list">
        {props.options.length ? (
          props.options.map((member) => (
            <button
              key={member.id}
              className="rooms-member-picker-option"
              type="button"
              onClick={() => props.onSelect(member)}
            >
              <RoomMemberAvatar member={member} />
              <span>
                <strong>{roomMemberDisplayName(member)}</strong>
                <small>
                  {member.kernel} / {memberModelLabel(member)}
                </small>
              </span>
            </button>
          ))
        ) : (
          <div className="rooms-member-picker-empty">
            {props.mode === "add" ? t("rooms.noAddableMembers") : t("rooms.noRemovableMembers")}
          </div>
        )}
      </div>
    </div>
  );
}
