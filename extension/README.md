# OpenGrove Browser Adapter

Tiny browser extension for sending page context into OpenGrove.

## Load

1. Open Chrome or Edge extension management.
2. Enable developer mode.
3. Choose "Load unpacked".
4. Select this repository's `extension/` directory.

## Protocol

- Selection snapshots dispatch `window.dispatchEvent(new CustomEvent("opengrove:snapshot", ...))`.
- The content script also posts `{ source: "opengrove-browser-adapter", type: "opengrove:snapshot", ... }`.
- Clicking the extension action sends `opengrove:toggle-sidebar`.
- Hosts can request a snapshot with `chrome.tabs.sendMessage(tabId, { type: "opengrove:get-snapshot" })`.

## Boundaries

- Does not call the local bridge directly.
- Does not persist page content.
- Does not read password inputs.
- Skips browser-internal pages and sensitive URL hints such as payment, checkout, bank, wallet, password, security, health, and medical.
