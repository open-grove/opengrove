# Responsive UI

OpenGrove uses one renderer, one business state model and one set of design tokens for desktop and small windows. Responsive components change placement and navigation without creating mobile copies of the editor, chat, employee model or host operations.

## Ownership

- `runtime/use-compact-layout.ts` owns the app shell's compact window policy (900 CSS px) and the visual viewport height. The shell consumes safe-area insets and reserves a layout row for bottom navigation. Compact navigation never writes desktop rail or sidebar widths.
- `components/app-shell/compact-navigation-dialog.tsx` presents the existing main rail and conversation list using the shared Radix Dialog. It preserves the same destinations, account actions and conversation actions.
- `components/shared/adaptive-split-layout.tsx` measures its own container. Below 760 CSS px, workspace and chat become peer panels using Base UI Tabs. Above it, the same panels form the existing resizable split. The component keeps both panels mounted and supplies their visibility to descendants.
- `components/shared/compact-list-detail.tsx` owns the compact list/detail presentation used by Rooms and Contacts. Selection remains in the feature that owns it. Returning to a list does not clear its selected item or the current chat draft.
- Feature CSS stays beside its component. Composer controls respond to their own container, employee fields keep their existing form model, and shared dialogs constrain content to the usable viewport. Long forms and resource previews can opt into `mobilePresentation="page"`; short confirmations keep their dialog presentation.

## Interaction contract

Workspace and chat remain peer tasks. Opening a file reveals its editor, and attaching an editor selection reveals the existing chat. The workspace tab, chat tab and directory back action are presentation state, separate from the selected file and its draft. Hidden panels are inert, cannot receive keyboard focus, and do not submit read receipts. Embedded App visibility follows the containing panel, while the iframe stays mounted.

Unread counts come from the existing Host-backed Rooms state. The compact chat tab shows the same App group unread count used by the main rail. New messages do not change the selected workspace panel.

Menus, dialogs and tabs reuse the installed Base UI and Radix components. Touch affordances supplement hover, double-click and context-menu interactions. Component styles use the shared tokens; local breakpoints may change a component's internal arrangement but must not redefine the application's grid.

The host constrains MCP App containers and provides navigation and visibility. Each embedded App remains responsible for its own forms, tables and other content within that container.

## Verification

`npm run test:web-compact-layout` exercises the built application at small widths and checks navigation, Rooms/Contacts round trips, draft retention, dialog bounds and restoration of the desktop rail width. It also exercises the production workbench composition for keyboard tab navigation, preserved editor/chat drafts, stable chat instances and desktop resizing. Both harnesses are registered in `tests/playwright/ui-harnesses.spec.ts`.

Run `npm run check:web:static` for type, renderer dependency, token, CSS and localization contracts. Existing desktop navigation and interaction harnesses remain applicable.

A framed desktop preview is a layout review aid, not an iOS emulator. Real-device verification is needed for Safari toolbar transitions, the software keyboard, native file pickers and device safe-area behavior. Product code uses available viewport dimensions rather than a fixed phone model height.
