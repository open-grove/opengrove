# Rooms P0 Frontend States

## Goal

Rooms is a Feishu-like conversation surface for OpenGrove kernels. It is not a second runtime.

The UI owns room layout, member targeting, mentions, attachments, and message grouping. Execution, approvals, tool activity, markdown rendering, and attachments must reuse the existing OpenGrove thread primitives.

## Reuse Contract

- Execution: post to the server Room API; the bridge records the user message, creates assistant placeholders, and schedules room runs in `src/server/room-runs.ts`.
- Runtime events: keep rendering the server-projected message parts with the existing thread primitives.
- Tool/activity UI: render tool, skill, approval, compaction, and choice-form parts with `AssistantProcessBlock`.
- Text UI: render assistant markdown with `ThreadTextBlock`.
- Attachment reading: keep using `readComposerAttachment`, `MAX_COMPOSER_ATTACHMENTS`, `attachmentIcon`, and `formatAttachmentMeta`.
- Buttons must either perform a real local action or be hidden/disabled. P0 should not show decorative fake controls.

## Primary Layout States

1. Message module selected from the left app rail.
2. Conversation list visible, with title `消息` and subtitle `对话列表`.
3. Optional pinned area visible only when at least one room is pinned.
4. Conversation list visible with group chats and direct kernel chats.
5. Search mode visible when the search box has text.
6. Search results appear as a small popover/list under the search box, not as a replacement for the conversation list.
7. Search results include installed kernels and matching existing conversations.
8. Clicking a kernel opens or creates a direct chat, then clears the search input and closes the result list.
9. Clicking an existing conversation opens it, then clears the search input and closes the result list.
10. Empty search state says no matching conversation or no matching installed kernel.
11. Main chat panel shows the selected room.
12. Member side panel is hidden by default.
13. Member side panel opens from member count or room menu.

## Conversation List States

1. Normal room row:
   - Avatar/icon.
   - Room title.
   - Badge when meaningful, such as `项目`, `私聊`, or `外部`.
   - Last update time.
   - Preview derived from the last real message.
2. Selected room row uses a subtle blue background.
3. Unread row shows count.
4. Pinned rooms are shown in the top pinned area only after user pins them.
5. Direct chat rows use the kernel icon.
6. Group rows use a group/hash style icon.
7. Search does not hide installed-kernel results behind existing room matches.
8. Newly created group is not pinned by default.

## Header States

1. Group header:
   - Group icon.
   - Room name.
   - Member count button.
   - More menu button.
2. Direct header:
   - Kernel icon.
   - Kernel/person name.
   - Member count button showing `1`.
   - More menu button.
3. More menu:
   - `设为置顶` or `取消置顶`.
   - `管理群成员` for groups.
   - `查看成员` for direct chats.
4. Member count button opens the member panel.
5. Header should not show dead search/video/calendar buttons in P0.

## Message Stream States

1. System notice:
   - Centered, compact, grey.
   - Used for room creation or local routing hints only.
2. User text:
   - Right aligned.
   - Blue bubble.
   - Plain text rendering.
   - Attachments below or near the bubble.
3. User attachment-only message:
   - Text fallback `发送了附件`.
   - Attachment chips/previews visible.
4. Agent running:
   - Left aligned.
   - Member avatar and name.
   - Shows `正在思考` only before any renderable runtime part exists.
5. Agent tool activity:
   - Rendered as `AssistantProcessBlock`.
   - Can be collapsed/expanded.
   - Must support multiple tool calls in one message.
6. Agent approval request:
   - Rendered through the existing approval UI.
   - Approve/reject must call `onResolveApproval`.
7. Agent choice form:
   - Rendered through the existing choice form UI.
   - Submitting a choice inserts or submits through the room composer callbacks.
8. Agent final text:
   - Rendered with `ThreadTextBlock`.
   - Can coexist with activity blocks in the same message.
9. Agent no-final-text response:
   - Activity block remains visible.
   - Status line still shows completion or failure.
10. Agent failure:
   - Message status becomes failed.
   - Error note is rendered through existing message parts.
11. Long markdown/code:
   - Bubble should wrap without breaking the room layout.
   - Code blocks should stay inside the bubble width.

## Composer States

1. Empty composer:
   - Placeholder is `发送给 {room}`.
   - Send button disabled.
2. Non-empty composer:
   - Send button enabled.
3. Attachment-only composer:
   - Send button enabled.
4. IME composition:
   - Enter during Chinese/Japanese/Korean composition must not send.
   - The first Enter immediately after composition end must not accidentally send when Enter ended the composition.
5. Enter:
   - Sends only when not composing and not holding Shift.
6. Shift + Enter:
   - Inserts a newline.
7. `@` button:
   - Opens the mention picker at the caret.
8. Typing `@`:
   - Opens the mention picker when the cursor is in a mention context.
9. Mention picker:
   - `@所有人` appears only in group chats.
   - Members are searchable.
   - Arrow keys move selection.
   - Enter/Tab chooses the highlighted item.
   - Escape closes the picker.
10. Attachment button:
   - Opens native file picker.
   - Supports multiple files up to `MAX_COMPOSER_ATTACHMENTS`.
   - Selected images show thumbnails.
   - Non-image files show compact chips.
   - Each attachment can be removed before sending.
11. Switching conversations:
   - Clears the active search query.
   - Clears unsent text and staged attachments in P0, so drafts do not leak into another room.

## Routing States

1. Group message without mention:
   - Only records the user message.
   - Does not trigger kernels.
2. Group message with `@member`:
   - Creates one running agent message for that member.
   - Sends the prompt through that member's kernel.
3. Group message with multiple mentions:
   - Creates one running agent message per target.
4. Group message with `@所有人`, `@全部`, or `@all`:
   - Targets all non-offline room members.
5. Direct chat without mention:
   - Sends to the direct member by default.
6. Direct chat with mention:
   - Mention still wins if the target is resolvable.
7. Attachments:
   - Sent with the same prompt to every target.

## Member Panel States

1. Group panel:
   - Title `群成员`.
   - Search input.
   - Member rows with name, role, kernel/model, and status.
   - Add-member action only appears when there is an installed kernel not already in the room.
2. Direct panel:
   - Title `成员`.
   - Shows the single direct member.
   - No fake remove or invite action in P0.
3. Footer:
   - Shows current model and pending approval count.

## Persistence And Recovery

1. Rooms persist in the server-backed room ledger under `data/local-state.sqlite`; large payloads live under `data/state-blobs/`.
2. The UI hydrates from `/rooms` and polls `/rooms/events` for ledger changes.
3. Installed kernel members are refreshed by the bridge from current runtime controls.
4. Runtime parts already stored on messages remain visible after refresh.
5. Rooms are local ledger records; the Web UI and local bridge synchronize them through the Rooms event API.

## Visual Acceptance Checklist

1. The screen reads like Feishu's message layout: conversation list, chat stream, optional right drawer.
2. The chat stream feels like a real chat, not cards stacked in a dashboard.
3. Tool activity appears inline as part of the agent's message.
4. Composer has no extra top divider and does not jump when attachments or mention menu appear.
5. All text wraps inside its container on narrow and wide viewports.
6. No visible P0 button is decorative.
7. Group pinning only happens after the user uses the more menu.
8. Direct-kernel search creates a usable private chat.
9. A real command-producing prompt shows the same activity information as the normal OpenGrove chat.
