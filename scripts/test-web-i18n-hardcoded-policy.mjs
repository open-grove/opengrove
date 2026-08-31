import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isGuardedWebSourceFile, normalizeRepositoryPath } from "./web-i18n-hardcoded-policy.mjs";

const sourceRoot = join("workspace", "web", "src");
const projectRoot = resolve(import.meta.dirname, "..");

assert.equal(
  normalizeRepositoryPath("web\\src\\components\\rooms\\room-view.tsx"),
  "web/src/components/rooms/room-view.tsx",
  "hardcoded-copy baseline paths must be stable across operating systems",
);

assert.equal(
  isGuardedWebSourceFile(sourceRoot, join(sourceRoot, "components", "rooms", "room-view.tsx")),
  true,
  "product TSX must remain inside the hardcoded-copy guard",
);
assert.equal(
  isGuardedWebSourceFile(sourceRoot, join(sourceRoot, "components", "room-model.ts")),
  true,
  "user-visible model strings must remain guarded",
);
assert.equal(
  isGuardedWebSourceFile(sourceRoot, join(sourceRoot, "future-surface", "route.tsx")),
  true,
  "every Web TSX surface must remain inside the hardcoded-copy guard",
);
assert.equal(
  isGuardedWebSourceFile(sourceRoot, join(sourceRoot, "runtime", "internal.ts")),
  false,
  "ordinary non-model TypeScript is outside this specialized guard",
);

const languageSniffingMatches = [
  ...runtimeSourceFiles(join(projectRoot, "web", "src")),
  ...runtimeSourceFiles(join(projectRoot, "src"), new Set(["tests"])),
].flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return /\bvisibleSystemText\b|Script=Han|\bhasHan\b|\bisUnlocalizedChineseMessage\b/u.test(source)
    ? [relative(projectRoot, file)]
    : [];
});
assert.deepEqual(
  languageSniffingMatches,
  [],
  "runtime localization must use locale metadata or error codes, never infer language from the text itself",
);

const contentMaskingMatches = [
  ...runtimeSourceFiles(join(projectRoot, "web", "src")),
  ...runtimeSourceFiles(join(projectRoot, "src"), new Set(["tests"])),
].flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return /\bsystemDetailText\b|\busesCanonicalText\b|\bstaleMountedAppMemberEnglishName\b|\bretiredConnectorNotice\b|\bhumanizeEmployeeIdentifier\b|\bhumanizeEnglishIdentifier\b|\bpublicRoomRunErrorText\b|\blocalizedLegacyRoomSystemText\b/u.test(
    source,
  ) || source.includes("English description unavailable.")
    ? [relative(projectRoot, file)]
    : [];
});
assert.deepEqual(
  contentMaskingMatches,
  [],
  "missing App locales and unknown server diagnostics must preserve source text instead of substituting generic localized copy",
);

const kernelUnavailableSurfaceFiles = [
  join(projectRoot, "web", "src", "components", "rooms", "contacts-model.ts"),
  join(projectRoot, "web", "src", "components", "rooms", "employee-dialog.tsx"),
  join(projectRoot, "web", "src", "components", "sidebar", "settings-kernel-panel.tsx"),
];
const directKernelReasonReads = kernelUnavailableSurfaceFiles.flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return /\b(?:kernel|selectedKernel|option)\.reason\b/u.test(source) ? [relative(projectRoot, file)] : [];
});
assert.deepEqual(
  directKernelReasonReads,
  [],
  "Kernel UI surfaces must render unavailable states through kernelUnavailableDescription instead of raw server diagnostics",
);

console.log("web i18n hardcoded policy harness ok");

function runtimeSourceFiles(root, excludedDirectories = new Set()) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return excludedDirectories.has(entry.name) ? [] : runtimeSourceFiles(join(root, entry.name), excludedDirectories);
    }
    return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) ? [join(root, entry.name)] : [];
  });
}
