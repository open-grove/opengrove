import { useEffect, useMemo, useRef, useState, type Ref, type SetStateAction } from "react";
import { useI18n } from "../../i18n";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { MotionMenu, MotionMenuItem, MotionMenuSeparator } from "../ui/motion/menu";
import { ProductIcon } from "../ui/product-icon";
import { Tooltip } from "../ui/tooltip";
import { formatShortTime, isDelegationTransportMessage } from "./room-message-model";
import { roomMemberDisplayName, type RoomMember, type RoomMessage } from "./rooms-model";
import "./room-workspace.css";

export function RoomHeaderActions(props: {
  roomId: string;
  roomTitle: string;
  messages: RoomMessage[];
  members: RoomMember[];
  compact?: boolean;
  searchOpen?: boolean;
  onSearchOpenChange?(open: boolean): void;
  menuOpen?: boolean;
  onMenuOpenChange?(open: boolean): void;
  onRename?(title: string): void;
  onOpenSettings?(): void;
  onDissolve?(): void;
  moreButtonRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [internalSearchOpen, setInternalSearchOpen] = useState(false);
  const [internalMenuOpen, setInternalMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(props.roomTitle);
  const [query, setQuery] = useState("");
  const searchOpen = props.searchOpen ?? internalSearchOpen;
  const menuOpen = props.menuOpen ?? internalMenuOpen;

  function updateSearchOpen(next: SetStateAction<boolean>) {
    const value = typeof next === "function" ? next(searchOpen) : next;
    if (props.searchOpen === undefined) setInternalSearchOpen(value);
    props.onSearchOpenChange?.(value);
  }

  function updateMenuOpen(open: boolean) {
    if (props.menuOpen === undefined) setInternalMenuOpen(open);
    props.onMenuOpenChange?.(open);
  }

  useEffect(() => {
    updateSearchOpen(false);
    updateMenuOpen(false);
    setRenameOpen(false);
    setRenameDraft(props.roomTitle);
    setQuery("");
    // Search is part of the room context and must not survive a room switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.roomId, props.roomTitle]);

  useEffect(() => {
    if (!searchOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      updateSearchOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      updateSearchOpen(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [searchOpen]);

  const searchableMessages = useMemo(
    () =>
      props.messages
        .filter((message) => !isDelegationTransportMessage(message))
        .map((message) => {
          const member = props.members.find((candidate) => candidate.id === message.senderId);
          const sender = member ? roomMemberDisplayName(member) : message.senderName;
          return {
            message,
            sender,
            searchText: `${sender}\n${message.text}`.toLocaleLowerCase(),
          };
        }),
    [props.members, props.messages],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results = normalizedQuery
    ? searchableMessages.filter((item) => item.searchText.includes(normalizedQuery)).slice(0, 40)
    : [];
  const hasMoreMenu = Boolean(props.onRename || props.onOpenSettings || props.onDissolve);

  function locateMessage(messageId: string) {
    const target = Array.from(document.querySelectorAll<HTMLElement>("[data-room-message-id]")).find(
      (element) => element.dataset.roomMessageId === messageId,
    );
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.dataset.searchHighlight = "true";
    window.setTimeout(() => {
      delete target.dataset.searchHighlight;
    }, 1_600);
    updateSearchOpen(false);
  }

  function submitRename() {
    const nextTitle = renameDraft.trim();
    if (!nextTitle || nextTitle === props.roomTitle) {
      setRenameOpen(false);
      return;
    }
    props.onRename?.(nextTitle);
    setRenameOpen(false);
  }

  return (
    <>
      <div className="room-header-tools" data-compact={props.compact ? "true" : "false"} ref={rootRef}>
        <div className="room-header-tool-wrap room-header-search-wrap">
          <Tooltip content={t("rooms.searchMessages")}>
            <button
              className="room-header-tool-button room-header-search-button"
              type="button"
              onClick={() => {
                updateMenuOpen(false);
                updateSearchOpen((open) => !open);
              }}
              aria-expanded={searchOpen}
              aria-label={t("rooms.searchMessages")}
            >
              <ProductIcon name="search" size={props.compact ? 18 : 20} />
            </button>
          </Tooltip>
          {searchOpen ? (
            <div className="room-message-search-popover" role="dialog" aria-label={t("rooms.searchMessages")}>
              <label className="room-message-search-field">
                <ProductIcon name="search" size={16} />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("rooms.searchMessagesPlaceholder")}
                />
                {query ? (
                  <button type="button" onClick={() => setQuery("")} aria-label={t("mountedApp.clearSearch")}>
                    <ProductIcon name="close" size={14} />
                  </button>
                ) : null}
              </label>
              <div className="room-message-search-results">
                {!normalizedQuery ? (
                  <p>{t("rooms.searchMessagesHint")}</p>
                ) : results.length ? (
                  results.map(({ message, sender }) => (
                    <button type="button" key={message.id} onClick={() => locateMessage(message.id)}>
                      <span>
                        <strong>{sender}</strong>
                        <small>{formatShortTime(message.createdAt)}</small>
                      </span>
                      <p>{message.text || t("rooms.messageWithoutText")}</p>
                    </button>
                  ))
                ) : (
                  <p>{t("rooms.noMatchingMessages")}</p>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {hasMoreMenu ? (
          <div className="room-header-tool-wrap">
            <MotionMenu
              open={menuOpen}
              onOpenChange={(open) => {
                updateMenuOpen(open);
                if (open) updateSearchOpen(false);
              }}
              ariaLabel={t("conversation.more")}
              className="room-header-more-menu"
              align="end"
              tooltipContent={t("conversation.more")}
              trigger={
                <button
                  ref={props.moreButtonRef}
                  className="room-header-tool-button room-header-more-button"
                  type="button"
                  aria-label={t("conversation.more")}
                >
                  <ProductIcon name="more" size={props.compact ? 19 : 21} />
                </button>
              }
            >
              {props.onRename ? (
                <MotionMenuItem
                  onClick={() => {
                    setRenameDraft(props.roomTitle);
                    setRenameOpen(true);
                  }}
                >
                  <ProductIcon name="edit" size={16} />
                  <span>{t("rooms.editName")}</span>
                </MotionMenuItem>
              ) : null}
              {props.onOpenSettings ? (
                <MotionMenuItem onClick={props.onOpenSettings}>
                  <ProductIcon name="settings" size={16} />
                  <span>{t("rooms.groupSettings")}</span>
                </MotionMenuItem>
              ) : null}
              {props.onDissolve ? <MotionMenuSeparator /> : null}
              {props.onDissolve ? (
                <MotionMenuItem danger onClick={props.onDissolve}>
                  <ProductIcon name="delete" size={16} />
                  <span>{t("rooms.dissolveGroup")}</span>
                </MotionMenuItem>
              ) : null}
            </MotionMenu>
          </div>
        ) : null}
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="room-rename-dialog" aria-label={t("rooms.editName")}>
          <DialogTitle>{t("rooms.editName")}</DialogTitle>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
          >
            <label>
              <span>{t("rooms.groupNameLabel")}</span>
              <input
                autoFocus
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setRenameOpen(false)}>
                {t("common.cancel")}
              </button>
              <button className="primary-button" type="submit" disabled={!renameDraft.trim()}>
                {t("filePreview.save")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
