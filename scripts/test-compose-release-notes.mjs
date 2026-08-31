import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { composeReleaseNotes } from "./compose-release-notes.mjs";

const english = `# OpenGrove v9.8.7

[Simplified Chinese](./v9.8.7.zh-CN.md)

English summary.

## Highlights

- English item

\`\`\`markdown
## Heading inside a fence
\`\`\`
`;

const chinese = `# OpenGrove v9.8.7

[English](./v9.8.7.md)

中文摘要。

## 主要变化

- 中文条目
`;

const composed = composeReleaseNotes(english, chinese);

assert.match(composed, /^# OpenGrove v9\.8\.7\n/);
assert.match(composed, /\[简体中文\]\(#简体中文\) · \[English\]\(#english\)/);
assert.ok(composed.indexOf("## 简体中文") < composed.indexOf("## English"));
assert.match(composed, /### 主要变化/);
assert.match(composed, /### Highlights/);
assert.match(composed, /```markdown\n## Heading inside a fence\n```/);
assert.doesNotMatch(composed, /\.\/v9\.8\.7/);
assert.throws(() => composeReleaseNotes("missing title", chinese), /level-one title/);

const fixtureRoot = mkdtempSync(join(tmpdir(), "opengrove-release-notes-"));
try {
  const notesDir = join(fixtureRoot, "docs", "releases");
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(join(notesDir, "v9.8.7.md"), english);
  writeFileSync(join(notesDir, "v9.8.7.zh-CN.md"), chinese);
  const outputPath = join(fixtureRoot, "composed.md");
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./compose-release-notes.mjs", import.meta.url)),
      "v9.8.7",
      outputPath,
      "--source-root",
      fixtureRoot,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(outputPath, "utf8"), /## English/);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("compose-release-notes tests passed");
