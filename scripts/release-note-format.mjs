import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const desktopReleaseNoteLocales = {
  en: {
    suffix: "",
    productHeading: "Product Updates",
    technicalHeading: "Technical Improvements",
  },
  "zh-CN": {
    suffix: ".zh-CN",
    productHeading: "产品更新",
    technicalHeading: "技术改进",
  },
};

export function releaseNoteSection(markdown, heading) {
  const lines = String(markdown).replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return undefined;
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^##\s+\S/u.test(line.trim()));
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

export function validateReleaseNote(markdown, { version, locale }) {
  const contract = desktopReleaseNoteLocales[locale];
  if (!contract) throw new Error(`unsupported release-note locale: ${locale}`);
  const normalized = String(markdown).replaceAll("\r\n", "\n").trim();
  const lines = normalized.split("\n");
  if (lines[0] !== `# OpenGrove v${version}`) {
    throw new Error(`${locale} release note must start with # OpenGrove v${version}`);
  }
  const levelTwoHeadings = lines.map((line) => line.match(/^##\s+(.+?)\s*$/u)?.[1]).filter(Boolean);
  const expectedHeadings = [contract.productHeading, contract.technicalHeading];
  if (JSON.stringify(levelTwoHeadings) !== JSON.stringify(expectedHeadings)) {
    throw new Error(
      `${locale} release note must contain only ${expectedHeadings.map((value) => `## ${value}`).join(" then ")}`,
    );
  }
  const productUpdates = releaseNoteSection(normalized, contract.productHeading);
  const technicalImprovements = releaseNoteSection(normalized, contract.technicalHeading);
  if (!meaningfulSection(productUpdates)) {
    throw new Error(`${locale} release note must include meaningful ${contract.productHeading} content`);
  }
  if (!meaningfulSection(technicalImprovements)) {
    throw new Error(`${locale} release note must include meaningful ${contract.technicalHeading} content`);
  }
  return { productUpdates, technicalImprovements };
}

export function readLocalizedDesktopReleaseNotes(root, version) {
  const releasesRoot = join(root, "docs", "releases");
  const result = {};
  for (const [locale, contract] of Object.entries(desktopReleaseNoteLocales)) {
    const path = join(releasesRoot, `v${version}${contract.suffix}.md`);
    if (!existsSync(path)) throw new Error(`missing release note: ${path}`);
    result[locale] = validateReleaseNote(readFileSync(path, "utf8"), { version, locale });
  }
  return result;
}

export function desktopProductReleaseNotes(root, version) {
  const localized = readLocalizedDesktopReleaseNotes(root, version);
  return {
    en: localized.en.productUpdates,
    "zh-CN": localized["zh-CN"].productUpdates,
  };
}

function meaningfulSection(value) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 && !/^(?:[-*]\s*)?(?:\.\.\.|TODO)\s*$/iu.test(normalized);
}
