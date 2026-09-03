import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const webDist = join(projectRoot, "web-dist");
const expectPresent = process.argv.includes("--expect-present");
const markers = [
  "cn-writer-a@example.test",
  "cn-reviewer-a@example.test",
  "us-reviewer-a@example.test",
  "OpenGrove fixture switcher",
  "切换测试账号",
  "Switch test account",
];

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
