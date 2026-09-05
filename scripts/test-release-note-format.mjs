import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopProductReleaseNotes, validateReleaseNote } from "./release-note-format.mjs";
import { collectReleaseNotesContext } from "./release-notes-context.mjs";

const english = `# OpenGrove v1.2.3

[Simplified Chinese](https://example.test/zh)

## Product Updates

- **Rooms** are easier to scan.
- [Apps](https://example.test/apps) show clearer progress.

## Technical Improvements

- The release pipeline verifies immutable artifacts.
`;
const chinese = `# OpenGrove v1.2.3

[English](https://example.test/en)

## 产品更新

- **房间**更容易浏览。

## 技术改进

- 发布流程会验证不可变制品。
`;

assert.deepEqual(validateReleaseNote(english, { version: "1.2.3", locale: "en" }), {
  productUpdates: "- **Rooms** are easier to scan.\n- [Apps](https://example.test/apps) show clearer progress.",
  technicalImprovements: "- The release pipeline verifies immutable artifacts.",
});

assert.throws(
  () =>
    validateReleaseNote(english.replace("## Technical Improvements", "## Internal Notes"), {
      version: "1.2.3",
      locale: "en",
    }),
  /must contain only/,
);
assert.throws(
  () =>
    validateReleaseNote(english.replace("- The release pipeline verifies immutable artifacts.", "TODO"), {
      version: "1.2.3",
      locale: "en",
    }),
  /meaningful Technical Improvements/,
);

const root = mkdtempSync(join(tmpdir(), "opengrove-release-notes-"));
try {
  mkdirSync(join(root, "docs", "releases"), { recursive: true });
  writeFileSync(join(root, "docs", "releases", "v1.2.3.md"), english);
  writeFileSync(join(root, "docs", "releases", "v1.2.3.zh-CN.md"), chinese);
  assert.deepEqual(desktopProductReleaseNotes(root, "1.2.3"), {
    en: "- **Rooms** are easier to scan.\n- [Apps](https://example.test/apps) show clearer progress.",
    "zh-CN": "- **房间**更容易浏览。",
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

const rootCommit = spawnSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
const context = collectReleaseNotesContext({ from: rootCommit, to: "HEAD" });
assert.match(context.range, /^[a-f0-9]{40}\.\.[a-f0-9]{40}$/u);
assert.ok(context.commits.length > 0);
assert.ok(context.files.some((line) => line.includes("package.json")));

console.log("release note format tests passed");
