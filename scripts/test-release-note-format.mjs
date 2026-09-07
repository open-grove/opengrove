import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopProductReleaseNotes, releaseNoteSection, validateReleaseNote } from "./release-note-format.mjs";

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

for (const example of [
  "```md\n## Example\n```",
  "~~~md\n## Example\n~~~",
  "````md\n```\n## Example\n~~~~\n## Still inside the original fence\n````",
]) {
  const productUpdates = `- Useful update.\n\n${example}\n\n- Another update.`;
  const fenced = [
    "# OpenGrove v1.2.3",
    "```md\n## Product Updates\n- This is an example, not the product section.\n```",
    "## Product Updates",
    productUpdates,
    "## Technical Improvements",
    "- Technical change.",
  ].join("\n\n");
  assert.equal(releaseNoteSection(fenced, "Product Updates"), productUpdates);
  assert.deepEqual(validateReleaseNote(fenced, { version: "1.2.3", locale: "en" }), {
    productUpdates,
    technicalImprovements: "- Technical change.",
  });
}

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

const productSection = "- **房间**更容易浏览。";
assert.equal(
  validateReleaseNote(chinese.replace(productSection, "界".repeat(21845)), { version: "1.2.3", locale: "zh-CN" })
    .productUpdates.length,
  21845,
  "the exact 65,535 UTF-8 byte boundary is accepted",
);
assert.throws(
  () => validateReleaseNote(chinese.replace(productSection, "界".repeat(21846)), { version: "1.2.3", locale: "zh-CN" }),
  /zh-CN.*65535.*UTF-8 bytes/u,
);
assert.doesNotThrow(() =>
  validateReleaseNote(chinese.replace("- 发布流程会验证不可变制品。", "界".repeat(21846)), {
    version: "1.2.3",
    locale: "zh-CN",
  }),
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
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3", clientReleaseNumber: 123 }));
  writeFileSync(join(root, "CHANGELOG.md"), "## Unreleased\n\n- A useful change.\n");
  const linkedEnglish = english.replace(
    "https://example.test/zh",
    "https://github.com/open-grove/opengrove/blob/v1.2.3/docs/releases/v1.2.3.zh-CN.md",
  );
  const linkedChinese = chinese.replace(
    "https://example.test/en",
    "https://github.com/open-grove/opengrove/blob/v1.2.3/docs/releases/v1.2.3.md",
  );
  writeFileSync(join(root, "docs", "releases", "v1.2.3.md"), linkedEnglish);
  writeFileSync(join(root, "docs", "releases", "v1.2.3.zh-CN.md"), linkedChinese);
  const checkScript = fileURLToPath(new URL("./check-release-notes.mjs", import.meta.url));
  for (const args of [[], ["--release"]]) {
    const valid = spawnSync(process.execPath, [checkScript, ...args], { cwd: root, encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
  }
  for (const [suffix, valid, heading] of [
    ["", linkedEnglish, "## Technical Improvements"],
    [".zh-CN", linkedChinese, "## 技术改进"],
  ]) {
    const path = join(root, "docs", "releases", `v1.2.3${suffix}.md`);
    writeFileSync(path, valid.replace(heading, "## Invalid section"));
    const invalid = spawnSync(process.execPath, [checkScript], { cwd: root, encoding: "utf8" });
    assert.equal(invalid.status, 1, "ordinary CI must reject malformed current-version notes in either locale");
    assert.match(invalid.stderr, /must contain only/u);
    writeFileSync(path, valid);
  }
  rmSync(join(root, "docs", "releases", "v1.2.3.md"));
  rmSync(join(root, "docs", "releases", "v1.2.3.zh-CN.md"));
  const unreleased = spawnSync(process.execPath, [checkScript], { cwd: root, encoding: "utf8" });
  assert.equal(unreleased.status, 0, "ordinary CI still allows an Unreleased buffer before drafting notes");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("release note format tests passed");
