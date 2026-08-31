(() => {
  try {
    const key = "opengroveTheme";
    const stored = localStorage.getItem(key);
    const preference = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    const resolved =
      preference === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = preference;
    document.documentElement.dataset.resolvedTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch {
    if (matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.dataset.theme = "system";
      document.documentElement.dataset.resolvedTheme = "dark";
      document.documentElement.style.colorScheme = "dark";
    }
  }
})();
