chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "opengrove:toggle-sidebar" }, () => {
    if (!chrome.runtime.lastError) {
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        files: ["content-script.js"],
      },
      () => {
        if (chrome.runtime.lastError) {
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: "opengrove:toggle-sidebar" }, () => {
          void chrome.runtime.lastError;
        });
      },
    );
  });
});
