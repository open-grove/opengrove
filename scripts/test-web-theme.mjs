import assert from "node:assert/strict";
import { resolveThemePreference } from "../web/src/theme-resolution.ts";

assert.equal(
  resolveThemePreference("system", { hostSystemTheme: "dark", browserSystemTheme: "light" }),
  "dark",
  "the desktop host theme must override matchMedia for system theme",
);
assert.equal(
  resolveThemePreference("system", { browserSystemTheme: "dark" }),
  "dark",
  "browser matchMedia remains the non-desktop fallback",
);
assert.equal(
  resolveThemePreference("light", { hostSystemTheme: "dark", browserSystemTheme: "dark" }),
  "light",
  "an explicit user preference must override both system sources",
);

console.log("web-theme ok");
