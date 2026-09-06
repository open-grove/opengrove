import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const webDist = join(projectRoot, "web-dist");
const expectPresent = process.argv.includes("--expect-present");
// Markers must be strings that exist ONLY when the switcher is compiled in.
//
// The fixture account addresses used to be listed here, but the switcher now
// fetches its list from ww at runtime, so those addresses are no longer in the
// bundle and checking for them would pass vacuously. What stays switcher-specific
// is the copy in dev-fixture-account-copy.ts, which tree-shakes away with the
// switcher itself.
//
// Deliberately NOT listed: anything from team-gate-copy.ts. The team-token gate
// is a legitimate runtime feature that belongs in production builds, so its
// strings ship either way -- including its own "no verification code" wording,
// which is why only phrasing unique to the dev-only file works as a marker.
const markers = ["切换测试账号", "Switch test account", "仅本地开发环境可用", "Available only in local development"];

if (!existsSync(webDist)) {
  console.error("missing Web build output: web-dist");
  process.exit(1);
}

const matches = [];
scan(webDist);

if (expectPresent) {
  if (matches.length === 0) {
    console.error("development Web build is missing the fixture account switcher");
    process.exit(1);
  }
  console.log(`Development Web build contains fixture account UI (${matches.length} marker matches).`);
} else {
  if (matches.length > 0) {
    for (const match of matches) console.error(`forbidden fixture account marker in ${match}`);
    process.exit(1);
  }
  console.log("Web build fixture account boundary passed: no fixture account data or UI markers found.");
}

function scan(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const child of readdirSync(path)) scan(join(path, child));
    return;
  }
  if (!stats.isFile()) return;

  const content = readFileSync(path, "utf8");
  for (const marker of markers) {
    if (content.includes(marker)) matches.push(`${relative(projectRoot, path)} (${JSON.stringify(marker)})`);
  }
}
