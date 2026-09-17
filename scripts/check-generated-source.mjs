import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readDesktopReleaseCandidateSource } from "./desktop-release-targets.mjs";

const projectRoot = process.cwd();
const { version } = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
readDesktopReleaseCandidateSource(projectRoot, version);
console.log("Generated source matches the checked-out commit.");
