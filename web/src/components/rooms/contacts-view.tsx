import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import "./rooms.css";
import "./rooms-layout.css";
import "./rooms-menus.css";
import "./contacts-view.css";
import { publishEmployeeToAppStore } from "../../bridge";
import type {
  ExtensionItemCollection,
  KernelOption,
  ModelId,
  ModelProviderBinding,
  ProviderProfile,
  RuntimeControls,
  SkillRecord,
} from "../../bridge";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { useConfirm } from "../ui/confirm-dialog";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { EmptyState } from "../ui/empty-state";
import { ProductIcon } from "../ui/product-icon";
import { useToast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { EmployeeDialog } from "./employee-dialog";
import { EmployeeSettingsSurface } from "./employee-settings-surface";
import { RoomMemberAvatar } from "./member-avatar";
import { visibleEmployeeDefinitions } from "./contacts-model";
import {
  openServerDirectRoom,
  patchServerRoomMember,
  restoreServerRoomMemberAppDefaults,
  upsertServerRoomMember,
} from "./rooms-api";
import {
  createId,
  dedupeRoomMembers,
  directRoomId,
  employeeProfilePatch,
  isAppScopedRoomId,
  nowIso,
  projectRoomMemberIdentity,
  remapRoomMemberReferences,
  roomMemberDisplayName,
  roomMemberDisplayPublicDescription,
  roomMemberSourceDetail,
  roomMemberSourceLabel,
  type Room,
  type RoomMember,
  type RoomsState,
} from "./rooms-model";

export function ContactsView(props: {
  activeKernel?: string;
  activeModel: ModelId;
  activeWorkspaceRoot: string;
  extensions?: ExtensionItemCollection;
  kernelOptions: KernelOption[];
  providers?: ProviderProfile[];
  modelProviderBindings?: ModelProviderBinding[];
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  skills?: SkillRecord[];
  roomsState: RoomsState;
  setRoomsState: Dispatch<SetStateAction<RoomsState>>;
  onOpenMessages(roomId?: string): void;
}) {
  const { t } = useI18n();
  const systemDetail = (error: unknown) =>
    rawDiagnosticText(error instanceof Error ? error.message : String(error ?? ""));
  const confirm = useConfirm();
  const { toast } = useToast();
  const state = props.roomsState;
  const setState = props.setRoomsState;
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState<"employees" | "groups">("employees");
  const [selectedMemberId, setSelectedMemberId] = useState(state.members[0]?.id || "");
  const [employeeDialogOpen, setEmployeeDialogOpen] = useState(false);
  const [publishingEmployee, setPublishingEmployee] = useState(false);
  const [employeeDeleteTargetId, setEmployeeDeleteTargetId] = useState("");

  const contactMembers = useMemo(() => {
    const deletedMembers = new Set(state.deletedMemberIds ?? []);
    return visibleEmployeeDefinitions(
      state.members.filter((member) => !deletedMembers.has(member.id) && !member.disabled),
    );
  }, [state.deletedMemberIds, state.members]);

  const employeeDeleteTarget = employeeDeleteTargetId
    ? contactMembers.find((member) => member.id === employeeDeleteTargetId)
    : undefined;

  useEffect(() => {
    if (selectedMemberId && contactMembers.some((member) => member.id === selectedMemberId)) return;
    setSelectedMemberId(contactMembers[0]?.id || "");
  }, [contactMembers, selectedMemberId]);

  const filteredMembers = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return contactMembers;
    return contactMembers.filter(
      (member) =>
        roomMemberDisplayName(member).toLowerCase().includes(value) ||
        member.name.toLowerCase().includes(value) ||
        member.role.toLowerCase().includes(value) ||
        member.kernel.toLowerCase().includes(value) ||
        member.model.toLowerCase().includes(value) ||
        roomMemberSourceLabel(member).toLowerCase().includes(value) ||
        roomMemberSourceDetail(member).toLowerCase().includes(value),
    );
  }, [contactMembers, query]);

  const visibleRooms = useMemo(() => state.rooms.filter((room) => !isAppScopedRoomId(room)), [state.rooms]);
  const groupRooms = useMemo(() => visibleRooms.filter((room) => room.kind === "group"), [visibleRooms]);
  const selectedMember =
    contactMembers.find((member) => member.id === selectedMemberId) ?? filteredMembers[0] ?? contactMembers[0];

  function persist(nextState: RoomsState) {
    setState(nextState);
    return nextState;
  }

  function createEmployee(member: RoomMember) {
    const previousMember = state.members.find((item) => item.id === member.id);
    const wasDeleted = (state.deletedMemberIds ?? []).includes(member.id);
    const previousSelectedMemberId = selectedMemberId;
    const restoredMember: RoomMember = {
      ...member,
      availableSkillIds: member.availableSkillIds ?? member.defaultSkillIds ?? [],
      defaultSkillIds: member.defaultSkillIds ?? [],
      disabled: false,
      status: member.status === "offline" ? "idle" : member.status,
      lastActive: t("ops.justNow"),
    };
    const nextMembers = state.members.some((item) => item.id === restoredMember.id)
      ? state.members.map((item) => (item.id === restoredMember.id ? { ...item, ...restoredMember } : item))
      : [...state.members, restoredMember];
    const deduped = dedupeRoomMembers(nextMembers);
    const selectedId = deduped.memberIdAliases.get(restoredMember.id) ?? restoredMember.id;
    const nextState = persist({
      ...state,
      members: deduped.members,
      rooms: state.rooms,
      deletedMemberIds: (state.deletedMemberIds ?? []).filter(
        (memberId) => memberId !== restoredMember.id && !deduped.memberIdAliases.has(memberId),
      ),
    });
    setSelectedMemberId(selectedId);
    if (selectedId === restoredMember.id) {
      void upsertServerRoomMember(restoredMember)
        .then((result) => applySyncedContactMember(restoredMember.id, result.member))
        .catch((error) => {
          // 只撤销本次添加；保留请求期间轮询到的新消息和成员更新。
          setState((current) => ({
            ...current,
            members: previousMember
              ? current.members.some((item) => item.id === previousMember.id)
                ? current.members.map((item) => (item.id === previousMember.id ? previousMember : item))
                : [...current.members, previousMember]
              : current.members.filter((item) => item.id !== restoredMember.id),
            deletedMemberIds: wasDeleted
              ? Array.from(new Set([...(current.deletedMemberIds ?? []), restoredMember.id]))
              : (current.deletedMemberIds ?? []).filter((memberId) => memberId !== restoredMember.id),
          }));
          setSelectedMemberId((current) => (current === selectedId ? previousSelectedMemberId : current));
          toast({ kind: "error", title: t("contacts.addEmployeeFailed", { message: systemDetail(error) }) });
        });
    }
    return nextState;
  }

  function applySyncedContactMember(previousMemberId: string, syncedMember: RoomMember | undefined) {
    if (!syncedMember?.id) return;
    setState((current) => {
      const withoutPrevious =
        previousMemberId === syncedMember.id
          ? current.members
          : current.members.filter((member) => member.id !== previousMemberId);
      const nextMembers = withoutPrevious.some((member) => member.id === syncedMember.id)
        ? withoutPrevious.map((member) => (member.id === syncedMember.id ? { ...member, ...syncedMember } : member))
        : [...withoutPrevious, syncedMember];
      const replacedRooms =
        previousMemberId === syncedMember.id
          ? current.rooms
          : current.rooms.map((room) => ({
              ...room,
              memberIds: room.memberIds.map((memberId) => (memberId === previousMemberId ? syncedMember.id : memberId)),
              directMemberId: room.directMemberId === previousMemberId ? syncedMember.id : room.directMemberId,
            }));
      const deduped = dedupeRoomMembers(nextMembers);
      const knownMemberIds = new Set(deduped.members.filter((member) => !member.disabled).map((member) => member.id));
      const rooms = projectRoomMemberIdentity(replacedRooms, previousMemberId, syncedMember).map((room) =>
        remapRoomMemberReferences(room, deduped.memberIdAliases, knownMemberIds),
      );
      const deletedMemberIds = (current.deletedMemberIds ?? []).filter(
        (memberId) =>
          memberId !== previousMemberId && memberId !== syncedMember.id && !deduped.memberIdAliases.has(memberId),
      );
      return { ...current, members: deduped.members, rooms, deletedMemberIds };
    });
    setSelectedMemberId((current) =>
      current === previousMemberId || current === syncedMember.id ? syncedMember.id : current,
    );
  }

  function openCreateEmployeeDialog() {
    setEmployeeDialogOpen(true);
  }

  function deleteEmployee(member: RoomMember) {
    const nextState: RoomsState = {
      ...state,
      members: state.members.map((item) =>
        item.id === member.id
          ? {
              ...item,
              disabled: true,
              status: "offline" as const,
            }
          : item,
      ),
      deletedMemberIds: Array.from(new Set([...(state.deletedMemberIds ?? []), member.id])),
    };
    const writtenState = persist(nextState);
    void patchServerRoomMember(member.id, {
      disabled: true,
      status: "offline",
    }).catch((error) => {
      // 只恢复被删除的员工，不覆盖请求期间到达的 room event。
      setState((current) => ({
        ...current,
        members: current.members.map((item) => (item.id === member.id ? member : item)),
        deletedMemberIds: (current.deletedMemberIds ?? []).filter((memberId) => memberId !== member.id),
      }));
      setSelectedMemberId(member.id);
      toast({ kind: "error", title: t("mountedApp.deleteGroupFailed", { message: systemDetail(error) }) });
    });
    const nextDeletedMembers = new Set(writtenState.deletedMemberIds ?? []);
    const nextSelectedId =
      writtenState.members.find((item) => !nextDeletedMembers.has(item.id) && !item.disabled)?.id || "";
    setSelectedMemberId(nextSelectedId);
  }

  function selectMember(memberId: string) {
    setSelectedMemberId(memberId);
    setActiveSection("employees");
  }

  // 把"只改了哪些字段"作为差量 PATCH 发给宿主：宿主据此标记 userOverrides，
  // 普通 mounted-app seed sync 不会把用户改过的字段冲回 manifest 默认值；
  // 安装 App 新版本时，宿主会在更新边界采用新版发布配置。
  // 本地仍乐观更新，并用宿主回写的 member（含 userOverrides/manifestDefaults）对齐；
  // 失败时回滚到编辑前的 member 快照，由调用方提示保存失败。
  async function persistMemberPatch(member: RoomMember, patch: Partial<RoomMember>): Promise<RoomMember> {
    const nextMember: RoomMember = { ...member, ...patch };
    persist({
      ...state,
      members: state.members.map((item) => (item.id === member.id ? nextMember : item)),
      rooms: projectRoomMemberIdentity(state.rooms, member.id, nextMember),
    });
    try {
      const result = await patchServerRoomMember(member.id, patch, { clearUndefined: true });
      applySyncedContactMember(member.id, result.member);
    } catch (error) {
      rollbackMemberPatch(member);
      throw error;
    }
    setSelectedMemberId(member.id);
    return nextMember;
  }

  // PATCH 失败时把界面上的编辑值回滚到操作前（= 服务端）的原值。
  function rollbackMemberPatch(previousMember: RoomMember) {
    setState((current) => ({
      ...current,
      members: current.members.map((item) => (item.id === previousMember.id ? previousMember : item)),
      rooms: projectRoomMemberIdentity(current.rooms, previousMember.id, previousMember),
    }));
  }

  async function publishSelectedEmployee() {
    if (!selectedMember || publishingEmployee) return;
    const confirmed = await confirm({
      title: t("confirm.publishEmployeeTitle"),
      body: t("confirm.publishEmployeeBody"),
      confirmLabel: t("common.confirm"),
    });
    if (confirmed !== "primary") return;
    setPublishingEmployee(true);
    try {
      const publicSummary = roomMemberDisplayPublicDescription(selectedMember)?.trim().slice(0, 160);
      const result = await publishEmployeeToAppStore({
        memberId: selectedMember.id,
        title: `${selectedMember.name} Employee Pack`,
        summary: publicSummary || undefined,
        category: t("app.rooms"),
      });
      toast({
        kind: "success",
        title: result.package
          ? t("contacts.publishedToStoreWithTitle", { title: result.package.title })
          : t("contacts.publishedToStore"),
      });
    } catch (error) {
      toast({
        kind: "error",
        title: t("contacts.publishFailed", { message: systemDetail(error) }),
        action: {
          label: t("common.retry"),
          onClick: () => void publishSelectedEmployee(),
        },
      });
    } finally {
      setPublishingEmployee(false);
    }
  }

  async function saveEmployeeProfile(nextMember: RoomMember) {
    const previousMember = state.members.find((member) => member.id === nextMember.id);
    if (!previousMember) return;
    const patch = employeeProfilePatch(previousMember, nextMember);
    if (!Object.keys(patch).length) return;
    await persistMemberPatch(previousMember, patch);
  }

  async function restoreSelectedEmployeeAppDefaults() {
    if (!selectedMember) return;
    const result = await restoreServerRoomMemberAppDefaults(selectedMember.id);
    applySyncedContactMember(selectedMember.id, result.member);
  }

  async function openDirectMember(member: RoomMember) {
    const roomId = directRoomId(member.id);
    const existing = state.rooms.find((room) => room.id === roomId);
    const createdAt = nowIso();
    const displayName = roomMemberDisplayName(member);
    const localRoom: Room = {
      id: roomId,
      kind: "direct",
      title: displayName,
      badge: t("contacts.directBadge"),
      memberIds: [member.id],
      adminMemberIds: [],
      directMemberId: member.id,
      pinned: false,
      unread: 0,
      updatedAt: createdAt,
      messages: [
        {
          id: createId("message"),
          senderId: "system",
          senderName: t("mountedApp.systemSenderName"),
          senderType: "system",
          text: t("contacts.directRoomWelcome", { name: displayName }),
          targetIds: [],
          status: "done",
          createdAt,
        },
      ],
    };
    const nextRooms: Room[] = existing ? state.rooms : [localRoom, ...state.rooms];
    persist({
      ...state,
      rooms: nextRooms.map((room) => (room.id === roomId ? { ...room, updatedAt: room.updatedAt || createdAt } : room)),
      activeRoomId: roomId,
    });
    if (existing) {
      props.onOpenMessages(roomId);
      return;
    }
    try {
      const result = await openServerDirectRoom(member.id, member.name, {
        roomId,
        member,
      });
      const serverRoomId = result.room.id;
      const serverRoom: Room = {
        ...result.room,
        messages: localRoom.messages,
      };
      persist({
        ...state,
        rooms: [serverRoom, ...state.rooms.filter((room) => room.id !== roomId && room.id !== serverRoomId)],
        activeRoomId: serverRoomId,
      });
      props.onOpenMessages(serverRoomId);
    } catch {
      // Server hydration is best-effort; the existing local direct Room remains usable.
      props.onOpenMessages(roomId);
    }
  }

  return (
    <section className="contacts-view" aria-label={t("contacts.viewLabel")}>
      <aside className="contacts-nav-panel">
        <header className="contacts-nav-header">
          <h1>{t("contacts.messages")}</h1>
          <Tooltip content={t("employee.addEmployee")} side="bottom">
            <button
              className="rooms-icon-button"
              type="button"
              data-room-action="add-employee"
              onClick={openCreateEmployeeDialog}
              aria-label={t("employee.addEmployee")}
            >
              <ProductIcon name="add" size={16} />
            </button>
          </Tooltip>
        </header>
        <nav className="collaboration-switch" aria-label={t("contacts.messageViews")}>
          <button type="button" data-room-view-target="rooms" onClick={() => props.onOpenMessages()}>
            {t("contacts.conversations")}
          </button>
          <button type="button" data-active="true" data-room-view-target="contacts">
            {t("contacts.viewLabel")}
          </button>
        </nav>
        <div className="rooms-search-wrap contacts-nav-search-wrap" data-open={query.trim() ? "true" : "false"}>
          <label className="rooms-search contacts-nav-search">
            <ProductIcon name="search" size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("contacts.searchPlaceholder")}
            />
            {query.trim() ? (
              <Tooltip content={t("contacts.clearSearch")}>
                <button
                  className="rooms-search-clear"
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("contacts.clearSearch")}
                >
                  <ProductIcon name="close" size={15} />
                </button>
              </Tooltip>
            ) : null}
          </label>
        </div>
        <section className="contacts-sidebar-directory" aria-label={t("contacts.employeeList")}>
          <div className="rooms-section-label contacts-nav-section-label">
            <span>{t("app.rooms")}</span>
            <small>{t("contacts.employeeCount", { count: contactMembers.length })}</small>
          </div>
          <div className="contacts-list contacts-sidebar-member-list">
            {filteredMembers.map((member) => (
              <button
                key={member.id}
                className="contacts-person-row"
                data-active={selectedMember?.id === member.id ? "true" : "false"}
                type="button"
                onClick={() => selectMember(member.id)}
              >
                <RoomMemberAvatar member={member} />
                <span>
                  <strong>{roomMemberDisplayName(member)}</strong>
                </span>
              </button>
            ))}
            {!filteredMembers.length ? (
              <div className="rooms-empty-row">{t("contacts.noMatchingEmployees")}</div>
            ) : null}
          </div>
        </section>
      </aside>

      <main className="contacts-main-panel">
        {activeSection === "employees" ? (
          <div className="contacts-detail-layout">
            <section
              className="contacts-detail-panel contacts-employee-detail"
              aria-label={t("contacts.employeeProfile")}
            >
              {selectedMember ? (
                <EmployeeSettingsSurface
                  key={selectedMember.id}
                  member={selectedMember}
                  rooms={visibleRooms}
                  activeKernel={props.activeKernel}
                  activeModel={props.activeModel}
                  extensions={props.extensions}
                  kernelOptions={props.kernelOptions}
                  providers={props.providers}
                  modelProviderBindings={props.modelProviderBindings}
                  runtimeControls={props.runtimeControls}
                  runtimeControlsByKernel={props.runtimeControlsByKernel}
                  skills={props.skills}
                  publishPending={publishingEmployee}
                  onMessage={() => void openDirectMember(selectedMember)}
                  onPublish={() => publishSelectedEmployee()}
                  onDelete={() => setEmployeeDeleteTargetId(selectedMember.id)}
                  onRestoreAppDefaults={restoreSelectedEmployeeAppDefaults}
                  onSave={saveEmployeeProfile}
                />
              ) : (
                <div className="rooms-empty-row">{t("contacts.selectEmployeeHint")}</div>
              )}
            </section>
          </div>
        ) : (
          <section className="contacts-group-list" aria-label={t("ops.sourceRooms")}>
            {groupRooms.map((room) => (
              <button
                className="contacts-group-row"
                key={room.id}
                type="button"
                onClick={() => props.onOpenMessages(room.id)}
              >
                <span className="contacts-group-icon" aria-hidden="true">
                  <ProductIcon name="rooms" size={18} />
                </span>
                <div>
                  <strong>{room.title}</strong>
                  <small>
                    {t("mountedApp.groupMemberCount", { count: room.memberIds.length })} · {room.badge}
                  </small>
                </div>
              </button>
            ))}
            {!groupRooms.length ? <EmptyState compact title={t("contacts.noGroupRooms")} /> : null}
          </section>
        )}
      </main>

      <EmployeeDialog
        open={employeeDialogOpen}
        activeKernel={props.activeKernel}
        activeModel={props.activeModel}
        runtimeControls={props.runtimeControls}
        runtimeControlsByKernel={props.runtimeControlsByKernel}
        kernelOptions={props.kernelOptions}
        providers={props.providers}
        modelProviderBindings={props.modelProviderBindings}
        onOpenChange={setEmployeeDialogOpen}
        onCreate={createEmployee}
        onSave={saveEmployeeProfile}
      />

      {employeeDeleteTarget ? (
        <Dialog open onOpenChange={(open) => (!open ? setEmployeeDeleteTargetId("") : undefined)}>
          <DialogContent className="contacts-confirm-dialog" aria-label={t("contacts.deleteEmployeeTitle")}>
            <DialogTitle>{t("contacts.deleteEmployeeTitle")}</DialogTitle>
            <p className="contacts-confirm-copy">
              {t("contacts.deleteEmployeeConfirm", { name: employeeDeleteTarget.name })}
            </p>
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setEmployeeDeleteTargetId("")}>
                {t("common.cancel")}
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  const target = employeeDeleteTarget;
                  setEmployeeDeleteTargetId("");
                  deleteEmployee(target);
                }}
              >
                {t("common.delete")}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
