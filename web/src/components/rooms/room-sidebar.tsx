import { MessageCircleMore, Plus, Search, UserPlus, UsersRound, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { ThemedPixelIcon } from "../sidebar/app-navigation";
import { MotionMenu, MotionMenuItem } from "../ui/motion/menu";
import { Tooltip } from "../ui/tooltip";
import { UnreadCount, UnreadCountAnchor } from "../ui/unread-count";
import { RoomMemberAvatar } from "./member-avatar";
import { RoomGroupAvatar, isGroveRoomTitle } from "./room-group-avatar";
import { findLastVisibleRoomMessage, formatRoomPreview, formatShortTime } from "./room-message-model";
import {
  directRoomMember,
  roomMemberDisplayName,
  roomMemberSourceDetail,
  roomMemberSourceLabel,
  type Room,
  type RoomMember,
} from "./rooms-model";

type RoomSidebarProps = {
  activeRoom: Room;
  rooms: Room[];
  members: RoomMember[];
  roomQuery: string;
  createMenuOpen: boolean;
  onCreateMenuOpenChange(open: boolean): void;
  onCreateGroup(): void;
  onRecruitEmployee(): void;
  onOpenContacts(): void;
  onRoomQueryChange(value: string): void;
  onOpenRoom(roomId: string): void;
  onOpenDirectMember(member: RoomMember): void;
};

export function RoomSidebar(props: RoomSidebarProps) {
  const { t } = useI18n();
  const pinnedRooms = props.rooms.filter((room) => room.pinned);
  const conversationRooms = props.rooms.filter((room) => !room.pinned);
  const query = props.roomQuery.trim().toLowerCase();
  const hasSearchQuery = Boolean(query);
  const roomSearchResults = query
    ? props.rooms.filter((room) => {
        const lastMessage = findLastVisibleRoomMessage(room.messages);
        const directMember = directRoomMember(room, props.members);
        const title = directMember ? roomMemberDisplayName(directMember) : room.title;
        return `${title} ${room.title} ${room.badge || ""} ${formatRoomPreview(lastMessage)}`
          .toLowerCase()
          .includes(query);
      })
    : [];
  const kernelSearchResults = query
    ? props.members.filter((member) => {
        if (member.disabled) return false;
        const text =
          `${roomMemberDisplayName(member)} ${member.name} ${member.kernel} ${member.role} ${member.model}`.toLowerCase();
        const sourceText = `${roomMemberSourceLabel(member)} ${roomMemberSourceDetail(member)}`.toLowerCase();
        return `${text} ${sourceText}`.includes(query);
      })
    : [];
  const hasSearchResults = kernelSearchResults.length > 0 || roomSearchResults.length > 0;

  return (
    <aside className="rooms-list-panel">
      <header className="rooms-list-header">
        <div className="rooms-list-title">
          <span className="rooms-title-icon" aria-hidden="true">
            <ThemedPixelIcon
              pixelIcon="messages"
              professionalIcon={MessageCircleMore}
              professionalSize={18}
              pixelSize={19}
            />
          </span>
          <div>
            <h1>{t("contacts.messages")}</h1>
            <p>{t("rooms.conversationList")}</p>
          </div>
        </div>
        <div className="rooms-create-menu-wrap">
          <MotionMenu
            open={props.createMenuOpen}
            onOpenChange={props.onCreateMenuOpenChange}
            ariaLabel={t("rooms.createNew")}
            className="rooms-create-menu"
            align="end"
            tooltipContent={t("rooms.createNew")}
            tooltipSide="bottom"
            trigger={
              <button className="rooms-icon-button" type="button" aria-label={t("rooms.createNew")}>
                <ThemedPixelIcon pixelIcon="plus" professionalIcon={Plus} professionalSize={16} pixelSize={17} />
              </button>
            }
          >
            <MotionMenuItem onClick={props.onCreateGroup}>
              <ThemedPixelIcon
                pixelIcon="messages"
                professionalIcon={UsersRound}
                professionalSize={17}
                pixelSize={18}
              />
              <span>{t("rooms.createGroup")}</span>
            </MotionMenuItem>
            <MotionMenuItem onClick={props.onRecruitEmployee}>
              <ThemedPixelIcon pixelIcon="user" professionalIcon={UserPlus} professionalSize={17} pixelSize={18} />
              <span>{t("employee.addEmployee")}</span>
            </MotionMenuItem>
          </MotionMenu>
        </div>
      </header>

      <nav className="collaboration-switch" aria-label={t("contacts.messageViews")}>
        <button type="button" data-active="true" data-room-view-target="rooms">
          {t("contacts.conversations")}
        </button>
        <button type="button" data-room-view-target="contacts" onClick={props.onOpenContacts}>
          {t("contacts.viewLabel")}
        </button>
      </nav>

      <div className="rooms-search-wrap" data-open={hasSearchQuery ? "true" : "false"}>
        <label className="rooms-search">
          <ThemedPixelIcon pixelIcon="search" professionalIcon={Search} professionalSize={14} pixelSize={16} />
          <input
            value={props.roomQuery}
            onChange={(event) => props.onRoomQueryChange(event.target.value)}
            placeholder={t("rooms.searchRoomsPlaceholder")}
          />
          {hasSearchQuery ? (
            <Tooltip content={t("contacts.clearSearch")}>
              <button
                className="rooms-search-clear"
                type="button"
                onClick={() => props.onRoomQueryChange("")}
                aria-label={t("contacts.clearSearch")}
              >
                <X size={15} />
              </button>
            </Tooltip>
          ) : null}
        </label>

        {hasSearchQuery ? (
          <section className="rooms-search-results" aria-label={t("rooms.searchResults")}>
            {kernelSearchResults.length ? (
              <div className="rooms-search-group">
                <div className="rooms-section-label">Kernel</div>
                <div className="rooms-kernel-results">
                  {kernelSearchResults.map((member) => (
                    <button
                      key={member.id}
                      className="rooms-kernel-result"
                      type="button"
                      onClick={() => props.onOpenDirectMember(member)}
                    >
                      <RoomMemberAvatar member={member} className="rooms-kernel-icon" />
                      <span className="rooms-list-copy">
                        <span className="rooms-list-name">{roomMemberDisplayName(member)}</span>
                      </span>
                      <span className="rooms-room-badge">{t("contacts.directBadge")}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {roomSearchResults.length ? (
              <div className="rooms-search-group">
                <div className="rooms-section-label">{t("contacts.conversations")}</div>
                <div className="rooms-kernel-results">
                  {roomSearchResults.map((room) => (
                    <RoomSearchResult key={room.id} room={room} members={props.members} onOpenRoom={props.onOpenRoom} />
                  ))}
                </div>
              </div>
            ) : null}
            {!hasSearchResults ? <div className="rooms-empty-row">{t("rooms.noMatchingRoomsOrKernels")}</div> : null}
          </section>
        ) : null}
      </div>

      {pinnedRooms.length ? (
        <section className="rooms-pinboard" aria-label={t("rooms.pinnedArea")}>
          <div className="rooms-section-label">{t("rooms.pinned")}</div>
          <div className="rooms-pinned-grid">
            {pinnedRooms.map((room) => {
              const directMember = directRoomMember(room, props.members);
              const title = directMember ? roomMemberDisplayName(directMember) : room.title;
              return (
                <button
                  key={room.id}
                  className="rooms-pin-item"
                  data-active={room.id === props.activeRoom.id ? "true" : "false"}
                  type="button"
                  onClick={() => props.onOpenRoom(room.id)}
                  aria-label={room.unread ? t("rooms.unreadCount", { title, count: room.unread }) : title}
                >
                  <UnreadCountAnchor count={room.unread} className="rooms-pin-unread-anchor">
                    {directMember && !isGroveRoomTitle(room.title) ? (
                      <RoomMemberAvatar member={directMember} className="rooms-pin-avatar" />
                    ) : (
                      <RoomGroupAvatar
                        title={room.title}
                        className="rooms-pin-avatar group"
                        members={membersForRoom(room, props.members)}
                      />
                    )}
                  </UnreadCountAnchor>
                  <span>{title}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="rooms-chat-list" aria-label={t("rooms.conversationList")}>
        <div className="rooms-section-label">{t("contacts.conversations")}</div>
        <div className="rooms-list-items">
          {conversationRooms.map((room) => (
            <RoomListItem
              key={room.id}
              room={room}
              active={room.id === props.activeRoom.id}
              members={props.members}
              onOpenRoom={props.onOpenRoom}
            />
          ))}
          {conversationRooms.length === 0 ? <div className="rooms-empty-row">{t("rooms.noMatchingRooms")}</div> : null}
        </div>
      </section>
    </aside>
  );
}

function RoomSearchResult(props: { room: Room; members: RoomMember[]; onOpenRoom(roomId: string): void }) {
  const { t } = useI18n();
  const directMember = directRoomMember(props.room, props.members);
  const title = directMember ? roomMemberDisplayName(directMember) : props.room.title;
  const lastMessage = findLastVisibleRoomMessage(props.room.messages);
  return (
    <button
      key={props.room.id}
      className="rooms-kernel-result"
      type="button"
      onClick={() => props.onOpenRoom(props.room.id)}
      aria-label={roomRowAriaLabel(t, title, formatRoomPreview(lastMessage), props.room.unread)}
    >
      {directMember && !isGroveRoomTitle(props.room.title) ? (
        <RoomMemberAvatar member={directMember} className="rooms-room-avatar direct" />
      ) : (
        <RoomGroupAvatar
          title={props.room.title}
          className="rooms-room-avatar"
          members={membersForRoom(props.room, props.members)}
        />
      )}
      <span className="rooms-list-copy">
        <span className="rooms-list-name">{title}</span>
        <span className="rooms-list-preview">{formatRoomPreview(lastMessage)}</span>
      </span>
      {props.room.badge ? <span className="rooms-room-badge">{props.room.badge}</span> : null}
      <UnreadCount count={props.room.unread} />
    </button>
  );
}

function RoomListItem(props: { room: Room; active: boolean; members: RoomMember[]; onOpenRoom(roomId: string): void }) {
  const { t } = useI18n();
  const lastMessage = findLastVisibleRoomMessage(props.room.messages);
  const directMember = directRoomMember(props.room, props.members);
  const title = directMember ? roomMemberDisplayName(directMember) : props.room.title;
  return (
    <button
      className="rooms-list-item"
      data-active={props.active ? "true" : "false"}
      type="button"
      onClick={() => props.onOpenRoom(props.room.id)}
      aria-label={roomRowAriaLabel(
        t,
        title,
        formatRoomPreview(lastMessage),
        props.room.unread,
        formatShortTime(props.room.updatedAt),
      )}
    >
      {directMember && !isGroveRoomTitle(props.room.title) ? (
        <RoomMemberAvatar member={directMember} className="rooms-room-avatar direct" />
      ) : (
        <RoomGroupAvatar
          title={props.room.title}
          className="rooms-room-avatar"
          members={membersForRoom(props.room, props.members)}
        />
      )}
      <span className="rooms-list-copy">
        <span className="rooms-list-name">{title}</span>
        <span className="rooms-list-preview">{formatRoomPreview(lastMessage)}</span>
      </span>
      {props.room.unread > 0 ? (
        <UnreadCount count={props.room.unread} />
      ) : (
        <span className="rooms-list-time">{formatShortTime(props.room.updatedAt)}</span>
      )}
    </button>
  );
}

function roomRowAriaLabel(
  t: ReturnType<typeof useI18n>["t"],
  title: string,
  preview: string,
  unread: number,
  time?: string,
): string {
  return [unread ? t("rooms.unreadCount", { title, count: unread }) : title, preview, unread ? undefined : time]
    .filter(Boolean)
    .join(", ");
}

function membersForRoom(room: Room, members: RoomMember[]): RoomMember[] {
  const memberIds = new Set(room.memberIds);
  return members.filter((member) => memberIds.has(member.id));
}
