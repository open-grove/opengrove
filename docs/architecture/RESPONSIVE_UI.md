# Responsive UI

OpenGrove uses one renderer, one business state model and one set of design tokens for desktop and small windows. Responsive components change placement and navigation without creating mobile copies of the editor, chat, employee model or host operations.

## Ownership

- `runtime/use-app-navigation.ts` connects React Router page history to the existing view preference. `runtime/use-page-detail.ts` records Room, employee and file details using the same router. The original `view` and `app` URLs remain supported; direct detail URLs have an explicit exit to their list. Browser history is owned here rather than separately in each feature.

- `runtime/use-compact-layout.ts` owns the app shell's compact window policy (900 CSS px) and the visual viewport height. The shell consumes safe-area insets and gives the space below the titlebar to the current page. Global navigation has one entry, the existing titlebar navigation button. Compact navigation never writes desktop rail or sidebar widths.
- `components/app-shell/compact-navigation-dialog.tsx` presents the existing main rail and conversation list in a full-height drawer attached to the left edge, using the shared Radix Dialog with `placement="left"`. It preserves the same destinations, account actions and conversation actions.
- `components/shared/adaptive-split-layout.tsx` measures its own container. Below 760 CSS px, workspace and chat occupy the same content area, controlled by the existing titlebar robot button. The measured compact state is reported to the shell so that the button follows the actual workbench width, including narrow containers inside a wide window. Above it, the same panels form the existing resizable split. The component keeps both panels mounted and supplies their visibility to descendants.
- `components/shared/compact-list-detail.tsx` owns the compact list/detail presentation used by Rooms and Contacts. Selection remains in the feature that owns it. Returning to a list does not clear its selected item or the current chat draft.
- Feature CSS stays beside its component. Composer controls respond to their own container, employee fields keep their existing form model, and shared dialogs constrain content to the usable viewport. Long forms and resource previews can opt into `mobilePresentation="page"`; short confirmations keep their dialog presentation.

## Interaction contract

Workspace and chat remain peer tasks. Opening a file reveals its editor, and attaching an editor selection reveals the existing chat. The robot button opens chat and returns to the previous workspace; no global bottom navigation or workspace/chat tab strip is added. App-owned content tabs keep their existing semantics. The compact pane and directory back action are presentation state, separate from the selected file and its draft. Compact chat visibility is also separate from the saved desktop chat-column preference. Hidden panels are inert, cannot receive keyboard focus, and do not submit read receipts. Embedded App visibility follows the containing panel, while the iframe stays mounted.

Unread counts come from the existing Host-backed Rooms state. The robot button shows the same App group unread count used by the main rail and retains the pending-action indicator; its accessible label includes both counts. New messages do not change the selected workspace panel.

Page navigation and detail history use React Router. The App Store publish form retains its leave confirmation on browser back/forward. Pane switches and Dialog subpages keep their own control semantics rather than adding a browser history entry for every focus change.

Menus, dialogs and tabs reuse the installed Base UI and Radix components. Touch affordances supplement hover, double-click and context-menu interactions. Component styles use the shared tokens; local breakpoints may change a component's internal arrangement but must not redefine the application's grid.

The host constrains MCP App containers and provides navigation and visibility. Each embedded App remains responsible for its own forms, tables and other content within that container.

## Verification

`npm run test:web-compact-layout` exercises the built application at small widths and checks navigation, Rooms/Contacts round trips, draft retention, edge-attached drawer bounds, outside-click dismissal and restoration of desktop rail and chat preferences. It also exercises the production workbench composition for keyboard-operated pane switching, preserved editor/chat drafts, stable chat instances and desktop resizing. Both harnesses also run with `OPENGROVE_UI_TEST_BROWSER=webkit` after installing Playwright WebKit. The built-app harness covers direct URLs, reload, browser back/forward, and file moves through the real Host API. Both harnesses are registered in `tests/playwright/ui-harnesses.spec.ts`.

Run `npm run check:web:static` for type, renderer dependency, token, CSS and localization contracts. Existing desktop navigation and interaction harnesses remain applicable.

A framed desktop preview is a layout review aid, not an iOS emulator. Real-device verification is needed for Safari toolbar transitions, the software keyboard, native file pickers and device safe-area behavior. Product code uses available viewport dimensions rather than a fixed phone model height.
