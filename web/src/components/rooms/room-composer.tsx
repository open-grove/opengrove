import {
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { Image as ImageIcon } from "lucide-react";
import type { AttachmentPayload } from "../../bridge";
import { useI18n } from "../../i18n";
import { attachmentIcon, attachmentImagePreviewUrl, formatAttachmentMeta } from "../../runtime/ui-model";
import { ProductIcon } from "../ui/product-icon";
import { MotionPopover } from "../ui/motion/popover";
import { Tooltip } from "../ui/tooltip";
import "../chat/opengrove-composer.css";
import "../shared/attachments.css";
import { RoomMemberAvatar } from "./member-avatar";
import type { RoomMember, RoomReplyPreview } from "./rooms-model";

export type MentionOption =
  | {
      id: "all";
      kind: "all";
      label: string;
      detail: string;
    }
  | {
      id: string;
      kind: "member";
      label: string;
      member: RoomMember;
    };

export function RoomComposer(props: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  roomTitle: string;
  draft: string;
  attachments: AttachmentPayload[];
  replyPreview?: RoomReplyPreview;
  canSend: boolean;
  mentionOpen: boolean;
  mentionOptions: MentionOption[];
  activeMentionIndex: number;
  onDraftChange(value: string, cursor: number): void;
  onAttachmentInputChange(event: ChangeEvent<HTMLInputElement>): void;
  onOpenAttachmentPicker(): void;
  onRemoveAttachment(attachmentId: string): void;
  onCancelReply(): void;
  onPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  onOpenMention(): void;
  onMentionOpenChange(open: boolean): void;
  onSelectMention(option: MentionOption): void;
  onHoverMention(index: number): void;
  onSend(): void;
}) {
  const { t } = useI18n();
  const composerRef = useRef<HTMLDivElement | null>(null);
  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    props.onDraftChange(event.target.value, event.target.selectionStart);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && props.replyPreview && !props.mentionOpen) {
      event.preventDefault();
      props.onCancelReply();
      return;
    }
    props.onKeyDown(event);
  }

  return (
    <section className="room-composer" aria-label={t("rooms.sendTo", { name: props.roomTitle })}>
      <div ref={composerRef} className="opengrove-composer room-composer-og" data-sending="false" data-skill="false">
        <MotionPopover
          open={props.mentionOpen}
          onOpenChange={props.onMentionOpenChange}
          anchorRef={composerRef}
          side="top"
          sideOffset={4}
          align="start"
          className="rooms-mention-menu"
          role="listbox"
          ariaLabel={t("rooms.mentionMenuLabel")}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            const target = event.target;
            if (target instanceof Node && composerRef.current?.contains(target)) {
              event.preventDefault();
            }
          }}
        >
          <MentionMenuContent
            options={props.mentionOptions}
            activeIndex={props.activeMentionIndex}
            onSelect={props.onSelectMention}
            onHover={props.onHoverMention}
          />
        </MotionPopover>
        {props.replyPreview ? (
          <div className="room-composer-reply">
            <div className="room-composer-reply-copy">
              <strong>{t("rooms.replyingTo", { name: props.replyPreview.senderName ?? "" })}</strong>
              <span title={props.replyPreview.text}>{props.replyPreview.text}</span>
            </div>
            <Tooltip content={t("rooms.cancelReply")}>
              <button
                className="room-composer-reply-close"
                type="button"
                onClick={props.onCancelReply}
                aria-label={t("rooms.cancelReply")}
              >
                <ProductIcon name="close" size={13} />
              </button>
            </Tooltip>
          </div>
        ) : null}
        {props.attachments.length ? (
          <RoomAttachmentBar attachments={props.attachments} onRemoveAttachment={props.onRemoveAttachment} />
        ) : null}
        <div className="opengrove-question-line" data-skill="false">
          <textarea
            ref={props.inputRef}
            className="opengrove-question"
            rows={1}
            value={props.draft}
            placeholder={t("rooms.sendTo", { name: props.roomTitle })}
            aria-label={t("rooms.sendTo", { name: props.roomTitle })}
            aria-expanded={props.mentionOpen}
            aria-haspopup="listbox"
            spellCheck={false}
            onChange={handleChange}
            onPaste={props.onPaste}
            onKeyDown={handleKeyDown}
            onCompositionStart={props.onCompositionStart}
            onCompositionEnd={props.onCompositionEnd}
          />
        </div>
        <div className="opengrove-composer-footer">
          <div className="opengrove-composer-footer-left">
            <input
              ref={props.fileInputRef}
              className="opengrove-file-input"
              type="file"
              multiple
              onChange={props.onAttachmentInputChange}
            />
            <Tooltip content={t("rooms.mentionMember")}>
              <button
                className="opengrove-action opengrove-composer-at"
                type="button"
                onClick={props.onOpenMention}
                aria-label={t("rooms.mentionMember")}
              >
                <ProductIcon name="mention" size={18} />
              </button>
            </Tooltip>
            <Tooltip content={t("rooms.uploadAttachment")}>
              <button
                className="opengrove-action opengrove-composer-plus"
                type="button"
                onClick={props.onOpenAttachmentPicker}
                aria-label={t("rooms.uploadAttachment")}
              >
                <ProductIcon name="add" size={20} />
              </button>
            </Tooltip>
          </div>
          <div className="opengrove-composer-footer-right">
            <Tooltip content={t("composer.send")}>
              <button
                className="opengrove-action opengrove-primary opengrove-send"
                type="button"
                onClick={props.onSend}
                disabled={!props.canSend}
                aria-label={t("composer.send")}
              >
                <ProductIcon name="send" size={17} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </section>
  );
}

function RoomAttachmentBar(props: {
  attachments: AttachmentPayload[];
  onRemoveAttachment(attachmentId: string): void;
}) {
  const { t } = useI18n();
  return (
    <div className="attachment-bar room-attachment-bar">
      {props.attachments.map((attachment) => {
        const Icon = attachmentIcon(attachment);
        if (attachment.kind === "image") {
          const previewUrl = attachmentImagePreviewUrl(attachment);
          return (
            <div className="opengrove-attachment" key={attachment.id} data-kind="image" aria-label={attachment.name}>
              {previewUrl ? (
                <img className="opengrove-attachment-thumb" src={previewUrl} alt="" />
              ) : (
                <span className="opengrove-attachment-image-fallback" aria-hidden="true">
                  <ImageIcon size={18} />
                </span>
              )}
              <Tooltip content={t("composer.removeAttachment", { name: attachment.name })}>
                <button
                  className="opengrove-action opengrove-icon opengrove-attachment-remove"
                  type="button"
                  onClick={() => props.onRemoveAttachment(attachment.id)}
                  aria-label={t("composer.removeAttachment", { name: attachment.name })}
                >
                  <ProductIcon name="close" size={13} />
                </button>
              </Tooltip>
            </div>
          );
        }
        return (
          <div className="opengrove-attachment" key={attachment.id} data-kind={attachment.kind}>
            <span className="opengrove-attachment-icon" aria-hidden="true">
              <Icon size={14} />
            </span>
            <span className="opengrove-attachment-name">
              {attachment.name}
              <span className="opengrove-attachment-meta">{formatAttachmentMeta(attachment)}</span>
            </span>
            <button
              className="opengrove-action opengrove-icon opengrove-attachment-remove"
              type="button"
              onClick={() => props.onRemoveAttachment(attachment.id)}
              aria-label={t("composer.removeAttachment", { name: attachment.name })}
            >
              <ProductIcon name="close" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function MentionMenuContent(props: {
  options: MentionOption[];
  activeIndex: number;
  onSelect(option: MentionOption): void;
  onHover(index: number): void;
}) {
  const { t } = useI18n();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const allOption = props.options.find(
    (option): option is Extract<MentionOption, { kind: "all" }> => option.kind === "all",
  );
  const allIndex = allOption ? props.options.indexOf(allOption) : -1;
  const memberOptions = props.options
    .map((option, index) => ({ option, index }))
    .filter(
      (item): item is { option: Extract<MentionOption, { kind: "member" }>; index: number } =>
        item.option.kind === "member",
    );

  useLayoutEffect(() => {
    if (props.activeIndex < 0 || props.activeIndex >= props.options.length) return;
    optionRefs.current[props.activeIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeIndex, props.options.length]);

  return (
    <>
      {allOption ? (
        <button
          ref={(element) => {
            optionRefs.current[allIndex] = element;
          }}
          className="rooms-mention-option all"
          data-active={props.activeIndex === allIndex ? "true" : "false"}
          type="button"
          role="option"
          aria-selected={props.activeIndex === allIndex}
          onMouseEnter={() => props.onHover(allIndex)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onSelect(allOption)}
        >
          <span className="rooms-mention-all-icon" aria-hidden="true">
            <ProductIcon name="mention" size={22} />
          </span>
          <span>
            <strong>{t("mountedApp.mentionAll")}</strong>
            <small>{allOption.detail}</small>
          </span>
        </button>
      ) : null}
      <div className="rooms-mention-section-title">{t("rooms.mentionSectionMembers")}</div>
      <div className="rooms-mention-list">
        {memberOptions.map(({ option, index }) => {
          return (
            <button
              key={option.id}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              className="rooms-mention-option"
              data-active={props.activeIndex === index ? "true" : "false"}
              type="button"
              role="option"
              aria-selected={props.activeIndex === index}
              onMouseEnter={() => props.onHover(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onSelect(option)}
            >
              <RoomMemberAvatar member={option.member} />
              <span>
                <strong>{option.label}</strong>
              </span>
            </button>
          );
        })}
        {memberOptions.length === 0 ? <div className="rooms-mention-empty">{t("rooms.noMatchingMembers")}</div> : null}
      </div>
    </>
  );
}
