import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const desktopReleasePlatformIds = Object.freeze(["mac-arm64", "mac-x64", "windows-x64"]);

const platformAliases = Object.freeze({
  windows: "windows-x64",
});

const macConfigurations = Object.freeze({
  "mac-arm64": Object.freeze({
    arch: "arm64",
    target: "mac-arm64",
    runner: "macos-15",
    ossutil_archive: "ossutil-2.3.0-mac-arm64.zip",
    ossutil_sha256: "058fd048f321f8c80def8b748030531646eefe3a82837bf16b581ba7d9c84ac7",
  }),
  "mac-x64": Object.freeze({
    arch: "x64",
    target: "mac-x64",
    runner: "macos-15-intel",
    ossutil_archive: "ossutil-2.3.0-mac-amd64.zip",
    ossutil_sha256: "8437fdd3ef1a3eb12310f61fcf1c00a5bff5cdab47b4fea815527472e7cf896c",
  }),
});

export function selectDesktopReleasePlatforms(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("platforms must be 'all' or a non-empty comma-separated platform list");
  }

  const requested = value.split(",").map((part) => part.trim());
  if (requested.some((part) => part.length === 0)) {
    throw new Error("platforms contains an empty entry");
  }
  if (requested.includes("all")) {
    if (requested.length !== 1) {
      throw new Error("platforms value 'all' cannot be combined with individual platforms");
    }
    requested.splice(0, 1, ...desktopReleasePlatformIds);
  }

  const selected = requested.map((platform) => platformAliases[platform] ?? platform);
  const unknown = selected.filter((platform) => !desktopReleasePlatformIds.includes(platform));
  if (unknown.length > 0) {
    throw new Error(`unsupported desktop release platform: ${unknown.join(", ")}`);
  }
  if (new Set(selected).size !== selected.length) {
    throw new Error("platforms contains duplicate entries");
  }

  const selectedSet = new Set(selected);
  const normalized = desktopReleasePlatformIds.filter((platform) => selectedSet.has(platform));
  const macMatrix = normalized
    .filter((platform) => platform.startsWith("mac-"))
    .map((platform) => ({ ...macConfigurations[platform] }));

  return {
    selected: normalized,
    runMac: macMatrix.length > 0,
    runWindows: selectedSet.has("windows-x64"),
    fullCandidate: normalized.length === desktopReleasePlatformIds.length,
    macMatrix,
  };
}

export function desktopReleasePlatformOutputs(selection) {
  return {
    platforms: selection.selected.join(","),
    mac_matrix: JSON.stringify(selection.macMatrix),
    run_mac: String(selection.runMac),
    run_windows: String(selection.runWindows),
    full_candidate: String(selection.fullCandidate),
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--platforms" && argument !== "--github-output") {
      throw new Error(`unsupported argument: ${argument}`);
    }
    const next = argv[index + 1];
    if (next === undefined) {
      throw new Error(`${argument} requires a value`);
    }
    options[argument.slice(2)] = next;
    index += 1;
  }
  return options;
}

function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (!options["github-output"]) {
    throw new Error("--github-output is required");
  }
  const outputs = desktopReleasePlatformOutputs(selectDesktopReleasePlatforms(options.platforms));
  appendFileSync(
    options["github-output"],
    `${Object.entries(outputs)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
