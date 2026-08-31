import type { ComponentProps } from "react";
import "./rooms.css";
import "./rooms-empty-state.css";
import "./rooms-layout.css";
import "./rooms-menus.css";
import "./room-workspace.css";
import "./room-members.css";
import { useI18n } from "../../i18n";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { EmptyState } from "../ui/empty-state";
import { ProductIcon } from "../ui/product-icon";
import { Tooltip } from "../ui/tooltip";
import { EmployeeDialog } from "./employee-dialog";
import { EmployeeSettingsDialog } from "./employee-settings-surface";
import { RoomChatSurface } from "./room-chat-surface";
import { RoomGroupAvatar } from "./room-group-avatar";
import { RoomHeaderActions } from "./room-header-actions";
import { RoomMemberAvatar } from "./member-avatar";
import { RoomSettingsPanel } from "./room-settings-panel";
import { RoomSidebar } from "./room-sidebar";
import { roomMemberDisplayName, type Room, type RoomMember } from "./rooms-model";

export function RoomsEmptyState(props: {
  loading: boolean;
  employeeDialogProps: ComponentProps<typeof EmployeeDialog>;
  onCreateEmployee(): void;
  onOpenContacts(): void;
}) {
  const { t } = useI18n();
  if (props.loading) {
    return <RoomsLoadingState />;
  }
  return (
    <section className="rooms-view rooms-unavailable-view rooms-onboarding-view" aria-label={t("contacts.messages")}>
      <EmptyState
        illustration="messages"
        title={t("rooms.emptyTitle")}
        description={t("rooms.emptyCopy")}
        actions={[
          { label: t("rooms.emptyCreateAction"), variant: "primary", onClick: props.onCreateEmployee },
          { label: t("rooms.emptyContactsAction"), onClick: props.onOpenContacts },
        ]}
      />
      <EmployeeDialog {...props.employeeDialogProps} />
    </section>
  );
}

export function RoomsLoadingState() {
  const { t } = useI18n();
  return (
    <section className="rooms-view rooms-loading-view" aria-label={t("contacts.messages")} aria-busy="true">
      <div className="og-skeleton-stack" role="status" aria-label={t("gate.roomsLoadingTitle")}>
        <span className="og-skeleton og-skeleton-line" style={{ width: "42%" }} />
        <span className="og-skeleton og-skeleton-line" style={{ width: "74%" }} />
        <span className="og-skeleton og-skeleton-line" style={{ width: "58%" }} />
      </div>
    </section>
  );
}

export function RoomsActiveLayout(props: {
  activeRoom: Room;
  activeRoomMembers: RoomMember[];
  activeDirectMember?: RoomMember;
  memberPanelOpen: boolean;
  runningRoomMembers: RoomMember[];
  sidebarProps: ComponentProps<typeof RoomSidebar>;
  chatSurfaceProps: ComponentProps<typeof RoomChatSurface>;
  settingsPanelProps: ComponentProps<typeof RoomSettingsPanel>;
  createGroupDialogProps: CreateGroupDialogProps;
  employeeDialogProps: ComponentProps<typeof EmployeeDialog>;
  employeeSettingsDialogProps?: ComponentProps<typeof EmployeeSettingsDialog>;
  onOpenMemberManager(): void;
  onOpenRoomMembers(): void;
  onOpenEmployeeProfile(member: RoomMember): void;
  onRenameRoom(title: string): void;
  onDissolveRoom(): void;
}) {
  const { t } = useI18n();
  const { activeRoom, activeDirectMember, memberPanelOpen, runningRoomMembers } = props;

  return (
    <section
      className="rooms-view"
      data-members-open={memberPanelOpen ? "true" : "false"}
      aria-label={t("contacts.messages")}
    >
      <RoomSidebar {...props.sidebarProps} />

      <section className="room-main-panel">
        <header className="room-header">
          <div className="room-header-main">
            {activeDirectMember ? (
              <Tooltip content={t("employee.profileSettingsTitle")} side="bottom">
                <button
                  className="room-header-avatar-button"
                  type="button"
                  onClick={() => props.onOpenEmployeeProfile(activeDirectMember)}
                  aria-label={t("employee.openSettingsFor", { name: roomMemberDisplayName(activeDirectMember) })}
                >
                  <RoomMemberAvatar member={activeDirectMember} className="room-header-avatar" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content={t("rooms.viewGroupMembers")} side="bottom">
                <button
                  className="room-header-avatar-button"
                  type="button"
                  onClick={props.onOpenRoomMembers}
                  aria-label={t("rooms.viewGroupMembers")}
                  aria-expanded={memberPanelOpen}
                >
                  <RoomGroupAvatar
                    title={activeRoom.title}
                    className="room-header-avatar"
                    members={props.activeRoomMembers}
                  />
                </button>
              </Tooltip>
            )}
            <div className="room-header-copy">
              <div className="room-title-row">
                <h2>{activeDirectMember ? roomMemberDisplayName(activeDirectMember) : activeRoom.title}</h2>
                {runningRoomMembers.length ? (
                  <span className="room-running-pill">
                    {t("rooms.membersRunning", { names: runningRoomMembers.map(roomMemberDisplayName).join("、") })}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="room-header-actions">
            <RoomHeaderActions
              roomId={activeRoom.id}
              roomTitle={activeRoom.title}
              messages={activeRoom.messages}
              members={props.activeRoomMembers}
              onRename={activeRoom.kind === "group" ? props.onRenameRoom : undefined}
              onOpenSettings={activeRoom.kind === "group" ? props.onOpenMemberManager : undefined}
              onDissolve={activeRoom.kind === "group" ? props.onDissolveRoom : undefined}
            />
          </div>
        </header>

        <RoomChatSurface {...props.chatSurfaceProps} />
      </section>

      <RoomSettingsPanel {...props.settingsPanelProps} />
      <CreateGroupDialog {...props.createGroupDialogProps} />
      <EmployeeDialog {...props.employeeDialogProps} />
      {props.employeeSettingsDialogProps ? <EmployeeSettingsDialog {...props.employeeSettingsDialogProps} /> : null}
    </section>
  );
}

export type CreateGroupDialogProps = {
  open: boolean;
  title: string;
  selectedMemberIds: string[];
  contactMembers: RoomMember[];
  onOpenChange(open: boolean): void;
  onTitleChange(value: string): void;
  onToggleMember(memberId: string): void;
  onCreate(): void;
};

export function CreateGroupDialog(props: CreateGroupDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="rooms-create-group-dialog" aria-label={t("rooms.createGroup")}>
        <DialogTitle>{t("rooms.createGroup")}</DialogTitle>
        <CreateGroupForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

export function CreateGroupForm(props: CreateGroupDialogProps) {
  const { t } = useI18n();
  const selectedMembers = props.contactMembers.filter((member) => props.selectedMemberIds.includes(member.id));
  return (
    <>
      <div className="rooms-create-group-hero">
        <RoomGroupAvatar
          title={props.title || t("rooms.createGroup")}
          className="rooms-create-group-avatar"
          members={selectedMembers}
        />
        <strong>{props.title.trim() || t("rooms.createGroup")}</strong>
      </div>
      <section className="rooms-create-group-section">
        <h3>{t("rooms.groupNameLabel")}</h3>
        <label className="rooms-create-group-name">
          <span>{t("rooms.groupNameLabel")}</span>
          <input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} />
        </label>
      </section>
      <section className="rooms-create-group-members">
        <div className="rooms-create-group-title">
          <strong>{t("rooms.chooseEmployees")}</strong>
          <span>
            {props.selectedMemberIds.length} / {props.contactMembers.length}
          </span>
        </div>
        <div className="rooms-create-group-list">
          {props.contactMembers.length ? (
            props.contactMembers.map((member) => (
              <label className="rooms-create-group-member" key={member.id}>
                <input
                  type="checkbox"
                  checked={props.selectedMemberIds.includes(member.id)}
                  onChange={() => props.onToggleMember(member.id)}
                />
                <RoomMemberAvatar member={member} />
                <span className="rooms-create-group-member-name">
                  <strong>{roomMemberDisplayName(member)}</strong>
                </span>
                <ProductIcon name="success" size={18} />
              </label>
            ))
          ) : (
            <div className="rooms-empty-row">{t("rooms.noEmployeesRecruitFirst")}</div>
          )}
        </div>
      </section>
      <div className="modal-actions">
        <button className="ghost-button" type="button" onClick={() => props.onOpenChange(false)}>
          {t("common.cancel")}
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={props.onCreate}
          disabled={!props.selectedMemberIds.length}
        >
          {t("mountedApp.create")}
        </button>
      </div>
    </>
  );
}
