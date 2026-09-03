import {
  useEffect,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import type { AgentEventRecord, AttachmentPayload } from "../../bridge";
import { useI18n } from "../../i18n";
import { RoomComposer, type MentionOption } from "./room-composer";
import { roomReplyPreview } from "./room-message-model";
import { RoomMessageStream } from "./room-message-stream";
import type { ChatImagePayload } from "../chat/message-types";
import type { ChatResourceAction, ChatResourceRef } from "../chat/resource-model";
import type { RoomMember, RoomMessage } from "./rooms-model";

export function RoomChatSurface(props: {
  streamRef?: Ref<HTMLElement>;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  roomId: string;
  roomTitle: string;
  messages: RoomMessage[];
  members: RoomMember[];
  workspaceRoot?: string;
  runtimeEventsByRunId: Map<string, AgentEventRecord[]>;
  pendingQuestionIds?: ReadonlySet<string>;
  pendingCancelRunIds?: ReadonlySet<string>;
  onCancelRun?(messageId: string, runId?: string): void;
  trailingContent?: ReactNode;
  draft: string;
  attachments: AttachmentPayload[];
  replyingToMessage?: RoomMessage;
  canSend: boolean;
  mentionOpen: boolean;
  mentionOptions: MentionOption[];
  activeMentionIndex: number;
  onResolveApproval(approvalId: string, action: "approve" | "reject" | "cancel", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline" | "cancel", response?: unknown): void;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onReplyMessage?(message: RoomMessage): void;
  onMentionMessageAuthor?(message: RoomMessage): void;
  onDeleteMessage?(messageId: string): void;
  onOpenMemberProfile?(member: RoomMember): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
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
  const [previewImage, setPreviewImage] = useState<ChatImagePayload | null>(null);
  const replyPreview = props.replyingToMessage
    ? roomReplyPreview(props.replyingToMessage, props.members, t)
    : undefined;

  useEffect(() => {
    if (previewImage) {
      blurActiveElement();
    }
  }, [previewImage]);

  return (
    <section className="room-chat-workspace-shell">
      <div className="room-chat-column">
        <section ref={props.streamRef} className="room-message-stream chat-thread-scroll" aria-live="polite">
          <RoomMessageStream
            roomId={props.roomId}
            messages={props.messages}
            members={props.members}
            workspaceRoot={props.workspaceRoot}
            runtimeEventsByRunId={props.runtimeEventsByRunId}
            pendingQuestionIds={props.pendingQuestionIds}
            pendingCancelRunIds={props.pendingCancelRunIds}
            onCancelRun={props.onCancelRun}
            trailingContent={props.trailingContent}
            onResolveApproval={props.onResolveApproval}
            onResolveQuestion={props.onResolveQuestion}
            onInsertPrompt={props.onInsertPrompt}
            onSubmitPrompt={props.onSubmitPrompt}
            onReplyMessage={props.onReplyMessage}
            onMentionMessageAuthor={props.onMentionMessageAuthor}
            onDeleteMessage={props.onDeleteMessage}
            onOpenMemberProfile={props.onOpenMemberProfile}
            onPreviewImage={setPreviewImage}
            onOpenResource={props.onOpenResource}
          />
        </section>

        <RoomComposer
          inputRef={props.composerInputRef}
          fileInputRef={props.fileInputRef}
          roomTitle={props.roomTitle}
          draft={props.draft}
          attachments={props.attachments}
          replyPreview={replyPreview}
          canSend={props.canSend}
          mentionOpen={props.mentionOpen}
          mentionOptions={props.mentionOptions}
          activeMentionIndex={props.activeMentionIndex}
          onDraftChange={props.onDraftChange}
          onAttachmentInputChange={props.onAttachmentInputChange}
          onOpenAttachmentPicker={props.onOpenAttachmentPicker}
          onRemoveAttachment={props.onRemoveAttachment}
          onCancelReply={props.onCancelReply}
          onPaste={props.onPaste}
          onKeyDown={props.onKeyDown}
          onCompositionStart={props.onCompositionStart}
          onCompositionEnd={props.onCompositionEnd}
          onOpenMention={props.onOpenMention}
          onMentionOpenChange={props.onMentionOpenChange}
          onSelectMention={props.onSelectMention}
          onHoverMention={props.onHoverMention}
          onSend={props.onSend}
        />
        {previewImage ? (
          <div
            className="thread-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={previewImage.alt || t("knowledge.imagePreview")}
            onClick={() => setPreviewImage(null)}
          >
            <div className="thread-image-lightbox-panel" onClick={(event) => event.stopPropagation()}>
              <div className="thread-image-lightbox-header">
                <div>{previewImage.alt || t("knowledge.imagePreview")}</div>
                <button
                  type="button"
                  className="thread-image-icon-button"
                  onClick={() => setPreviewImage(null)}
                  aria-label={t("knowledge.closePreview")}
                >
                  <X size={16} />
                </button>
              </div>
              <img src={previewImage.src} alt={previewImage.alt || t("knowledge.imagePreview")} />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function blurActiveElement(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
}
