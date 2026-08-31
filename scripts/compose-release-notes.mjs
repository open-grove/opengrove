import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LANGUAGE_SWITCH_LINK = /^\[(?:Simplified Chinese|简体中文|English)\]\([^)]+\)\s*$/;

function noteBody(markdown, sourceName) {
  const lines = markdown.trim().split(/\r?\n/);
  if (!/^#\s+\S/.test(lines[0] ?? "")) {
    throw new Error(`${sourceName} must start with a level-one title`);
  }

  lines.shift();
  while (lines[0]?.trim() === "") lines.shift();
  if (LANGUAGE_SWITCH_LINK.test(lines[0] ?? "")) lines.shift();
  while (lines[0]?.trim() === "") lines.shift();

  let fenceCharacter = "";
  return lines
    .map((line) => {
      const fence = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        const character = fence[1][0];
        fenceCharacter = fenceCharacter === character ? "" : character;
        return line;
      }
      return fenceCharacter ? line : line.replace(/^(#{2,5})(?=\s)/, "#$1");
    })
    .join("\n")
    .trim();
}

export function composeReleaseNotes(englishMarkdown, chineseMarkdown, sourceNames = {}) {
  const englishName = sourceNames.english ?? "English release note";
  const chineseName = sourceNames.chinese ?? "Chinese release note";
  const title = englishMarkdown.trim().split(/\r?\n/, 1)[0];

  return [
    title,
    "",
    "[简体中文](#简体中文) · [English](#english)",
    "",
    "## 简体中文",
    "",
    noteBody(chineseMarkdown, chineseName),
    "",
    "---",
    "",
    "## English",
    "",
    noteBody(englishMarkdown, englishName),
    "",
  ].join("\n");
}

function main(args) {
  const positional = [];
  let sourceRoot = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--source-root") sourceRoot = args[++index];
    else if (value.startsWith("--source-root=")) sourceRoot = value.slice("--source-root=".length);
    else positional.push(value);
  }
  const [tag, outputPath] = positional;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "") || positional.length > 2 || !sourceRoot) {
    throw new Error("usage: node scripts/compose-release-notes.mjs vX.Y.Z [output-file] [--source-root DIR]");
  }

  const root = process.cwd();
  const resolvedSourceRoot = resolve(root, sourceRoot);
  const englishPath = join(resolvedSourceRoot, "docs", "releases", `${tag}.md`);
  const chinesePath = join(resolvedSourceRoot, "docs", "releases", `${tag}.zh-CN.md`);
  for (const sourcePath of [englishPath, chinesePath]) {
    if (!existsSync(sourcePath)) throw new Error(`missing release note: ${sourcePath}`);
  }

  const composed = composeReleaseNotes(readFileSync(englishPath, "utf8"), readFileSync(chinesePath, "utf8"), {
    english: englishPath,
    chinese: chinesePath,
  });

  if (!outputPath) {
    process.stdout.write(composed);
    return;
  }

  const resolvedOutputPath = resolve(root, outputPath);
  mkdirSync(dirname(resolvedOutputPath), { recursive: true });
  writeFileSync(resolvedOutputPath, composed);
  console.log(`Wrote bilingual GitHub Release notes to ${resolvedOutputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Release note composition failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
