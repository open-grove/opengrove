#!/usr/bin/env node
// 文档引用校验：markdown 链接指向的仓库内路径必须真实存在。
// 哲学同 tokens:check——文档里的引用是契约，断链 = drift，CI 里直接报错。
// 范围：全仓 .md 的相对链接；不含纯文本/反引号提及（噪声高，见 whitelist 处理本地目录）。

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";

const repoRoot = process.cwd();

// 跳过的目录：构建产物、依赖、以及明确「不再维护」的归档区
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "web-dist",
  "desktop-dist",
  "release",
  ".codex",
  ".codex-worktrees",
  ".claude",
  ".cache",
  "data",
]);
const SKIP_PATH_PREFIXES = [
  join("docs", "archive"), // 归档区自述「内容可能与当前代码不符」，不校验
];

// 白名单前缀：约定俗成的本地未入库目录（AGENTS.md 有说明），引用它们不算断链
const LOCAL_UNTRACKED_PREFIXES = ["ref", ".codex", "docs.local", ".opengrove"];
function isSkippedPath(relPath) {
  return SKIP_PATH_PREFIXES.some((p) => relPath === p || relPath.startsWith(p + sep));
}

function* walkMarkdown(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(repoRoot, abs);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || isSkippedPath(rel)) continue;
      yield* walkMarkdown(abs);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      if (!isSkippedPath(rel)) yield abs;
    }
  }
}

function advanceFence(line, currentFence) {
  if (currentFence) {
    const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (closing && closing[1][0] === currentFence.marker && closing[1].length >= currentFence.length) {
      return { fence: null, boundary: true };
    }
    return { fence: currentFence, boundary: false };
  }

  const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!opening || (opening[1][0] === "`" && opening[2].includes("`"))) {
    return { fence: null, boundary: false };
  }
  return {
    fence: { marker: opening[1][0], length: opening[1].length },
    boundary: true,
  };
}

const LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)/g;
const EXTERNAL_RE = /^(https?:|mailto:|data:|tel:|#)/i;

const misses = [];
const structureMisses = [];
let filesScanned = 0;
let linksChecked = 0;

function markdownHeadingLevels(file) {
  const levels = [];
  let fence = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const transition = advanceFence(line, fence);
    fence = transition.fence;
    if (transition.boundary || fence) continue;
    const heading = line.match(/^\s{0,3}(#{1,6})\s+\S/);
    if (heading) levels.push(heading[1].length);
  }
  return levels;
}

const markdownFiles = [...walkMarkdown(repoRoot)];

for (const file of markdownFiles) {
  filesScanned += 1;
  const lines = readFileSync(file, "utf8").split("\n");
  let fence = null;
  lines.forEach((rawLine, idx) => {
    const transition = advanceFence(rawLine, fence);
    fence = transition.fence;
    if (transition.boundary || fence) return;
    // 行内代码里的「链接」是示例，不是引用
    const line = rawLine.replace(/``[^`]*``/g, "").replace(/`[^`]*`/g, "");
    for (const match of line.matchAll(LINK_RE)) {
      let target = match[1].trim().split(/\s+/)[0].replace(/^<|>$/g, "");
      if (!target || EXTERNAL_RE.test(target)) continue;
      target = target.split("#")[0].split("?")[0];
      if (!target) continue;
      const resolved = target.startsWith("/") ? resolve(repoRoot, target.slice(1)) : resolve(dirname(file), target);
      const relToRoot = relative(repoRoot, resolved);
      if (relToRoot.startsWith("..")) continue; // 指向仓库外，不管
      if (LOCAL_UNTRACKED_PREFIXES.some((p) => relToRoot === p || relToRoot.startsWith(p + sep))) continue;
      linksChecked += 1;
      if (!existsSync(resolved)) {
        misses.push({ file: relative(repoRoot, file), line: idx + 1, target: match[1].trim() });
      }
    }
  });
}

const bilingualDocs = new Set();
for (const file of markdownFiles) {
  const relativePath = relative(repoRoot, file);
  if (relativePath.endsWith(".zh-CN.md")) {
    bilingualDocs.add(relativePath.replace(/\.zh-CN\.md$/, ".md"));
  }
}

// Compare every existing first-party Chinese translation with its English
// source. This checks heading depth and order, not translated heading text, and
// does not require any particular document pair to exist forever.
for (const englishRelative of bilingualDocs) {
  const chineseRelative = englishRelative.replace(/\.md$/, ".zh-CN.md");
  const english = resolve(repoRoot, englishRelative);
  const chinese = resolve(repoRoot, chineseRelative);
  if (!existsSync(english)) {
    structureMisses.push({
      english: englishRelative,
      chinese: chineseRelative,
      detail: "English source missing",
    });
    continue;
  }

  const englishLevels = markdownHeadingLevels(english);
  const chineseLevels = markdownHeadingLevels(chinese);
  if (JSON.stringify(englishLevels) !== JSON.stringify(chineseLevels)) {
    const differenceIndex = englishLevels.findIndex((level, index) => level !== chineseLevels[index]);
    const firstDifference =
      differenceIndex === -1 ? Math.min(englishLevels.length, chineseLevels.length) : differenceIndex;
    structureMisses.push({
      english: englishRelative,
      chinese: chineseRelative,
      detail: `heading ${firstDifference + 1}: level ${englishLevels[firstDifference] ?? "missing"} != ${chineseLevels[firstDifference] ?? "missing"}`,
    });
  }
}

if (misses.length > 0 || structureMisses.length > 0) {
  console.error(
    `check:doc-refs FAILED — ${misses.length} broken reference(s), ${structureMisses.length} bilingual structure mismatch(es):\n`,
  );
  for (const m of misses) console.error(`  ${m.file}:${m.line} -> ${m.target}`);
  for (const mismatch of structureMisses) {
    console.error(`  ${mismatch.english} != ${mismatch.chinese} (${mismatch.detail})`);
  }
  console.error(`\n(scanned ${filesScanned} files, ${linksChecked} repo-relative links)`);
  process.exit(1);
}
console.log(
  `check:doc-refs OK — ${linksChecked} repo-relative links across ${filesScanned} markdown files all resolve.`,
);
