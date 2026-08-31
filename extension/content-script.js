(function opengroveBrowserAdapter() {
  const INSTALL_KEY = "__opengroveBrowserAdapterInstalled";
  const SNAPSHOT_EVENT = "opengrove:snapshot";
  const MESSAGE_SOURCE = "opengrove-browser-adapter";
  const TOGGLE_MESSAGE = "opengrove:toggle-sidebar";
  const GET_SNAPSHOT_MESSAGE = "opengrove:get-snapshot";
  const SENSITIVE_URL_HINTS = [
    "password",
    "billing",
    "checkout",
    "payment",
    "bank",
    "wallet",
    "medical",
    "health",
    "security",
  ];
  let snapshotTimer = 0;

  if (window[INSTALL_KEY]) {
    return;
  }
  if (isSensitivePage()) {
    return;
  }
  window[INSTALL_KEY] = true;

  document.addEventListener("selectionchange", scheduleSnapshotDispatch, true);
  document.addEventListener("mouseup", scheduleSnapshotDispatch, true);
  document.addEventListener("keyup", scheduleSnapshotDispatch, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    if (message.type === GET_SNAPSHOT_MESSAGE) {
      sendResponse({ ok: true, snapshot: createSnapshot() });
      return true;
    }
    if (message.type === TOGGLE_MESSAGE) {
      dispatchSnapshot("extension-action");
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  function scheduleSnapshotDispatch() {
    window.clearTimeout(snapshotTimer);
    snapshotTimer = window.setTimeout(() => dispatchSnapshot("selectionchange"), 160);
  }

  function dispatchSnapshot(reason) {
    const snapshot = createSnapshot();
    const detail = { reason, snapshot };
    window.dispatchEvent(new CustomEvent(SNAPSHOT_EVENT, { detail }));
    window.postMessage({ source: MESSAGE_SOURCE, type: SNAPSHOT_EVENT, ...detail }, "*");
  }

  function createSnapshot() {
    const selection = safeSelection();
    return {
      url: location.href,
      title: document.title || "",
      selection: selection.text,
      visibleText: visibleText(),
      locator: selection.locator,
      capturedAt: new Date().toISOString(),
    };
  }

  function safeSelection() {
    const selected = window.getSelection();
    if (!selected || selected.rangeCount === 0) {
      return { text: "", locator: "" };
    }
    const text = selected.toString().trim();
    if (!text) {
      return { text: "", locator: "" };
    }
    const range = selected.getRangeAt(0);
    return {
      text: truncate(text, 10_000),
      locator: createRangeLocator(range),
    };
  }

  function visibleText() {
    const candidates = Array.from(document.querySelectorAll("main, article, [role='main'], body"));
    const root = candidates.find((node) => textContent(node).length > 200) || document.body;
    return truncate(textContent(root), 20_000);
  }

  function textContent(node) {
    return String(node?.innerText || node?.textContent || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function createRangeLocator(range) {
    const start = elementPath(range.startContainer);
    const end = elementPath(range.endContainer);
    return [start, end].filter(Boolean).join(" -> ");
  }

  function elementPath(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return "";
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 5) {
      const tag = current.tagName ? current.tagName.toLowerCase() : "node";
      const id = current.id ? `#${current.id}` : "";
      const className = current.classList?.length ? `.${Array.from(current.classList).slice(0, 2).join(".")}` : "";
      parts.unshift(`${tag}${id}${className}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function truncate(value, maxLength) {
    const text = String(value || "");
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
  }

  function isSensitivePage() {
    const href = location.href.toLowerCase();
    return SENSITIVE_URL_HINTS.some((hint) => href.includes(hint));
  }
})();
