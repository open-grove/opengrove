import { join, resolve } from "node:path";
import { writeDesktopReleaseGateReceipt } from "./desktop-release-gate-receipt.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const releaseDir = resolve(args.releaseDir ?? join(projectRoot, "release", "desktop"));
const ciRunUrl = args.ciRunUrl ?? process.env.OPENGROVE_RELEASE_CI_RUN_URL ?? githubRunUrl();
const previousReleaseTag = args.previousReleaseTag ?? process.env.OPENGROVE_PREVIOUS_RELEASE_TAG ?? "";
const receipt = await writeDesktopReleaseGateReceipt({
  releaseDir,
  ciRunUrl,
  previousReleaseTag,
  outputPath: args.out ? resolve(args.out) : undefined,
});
console.log(
  `write-desktop-release-gate-receipt: ${receipt.expected_git_tag}@${receipt.git_commit.slice(0, 12)} passed ${Object.keys(receipt.gates).length} gates.`,
);

function githubRunUrl() {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repository && runId ? `${server}/${repository}/actions/runs/${runId}` : "";
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--release-dir") result.releaseDir = readRequired(values, ++index, value);
    else if (value.startsWith("--release-dir=")) result.releaseDir = value.slice("--release-dir=".length);
    else if (value === "--ci-run-url") result.ciRunUrl = readRequired(values, ++index, value);
    else if (value.startsWith("--ci-run-url=")) result.ciRunUrl = value.slice("--ci-run-url=".length);
    else if (value === "--previous-release-tag") result.previousReleaseTag = readRequired(values, ++index, value);
    else if (value.startsWith("--previous-release-tag="))
      result.previousReleaseTag = value.slice("--previous-release-tag=".length);
    else if (value === "--out") result.out = readRequired(values, ++index, value);
    else if (value.startsWith("--out=")) result.out = value.slice("--out=".length);
    else throw new Error(`Unknown write-desktop-release-gate-receipt option: ${value}`);
  }
  return result;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
