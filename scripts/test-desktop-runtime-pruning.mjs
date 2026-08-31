import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "..");
const config = load(readFileSync(resolve(root, "electron-builder.yml"), "utf8"));

assert.ok(Array.isArray(config.files), "desktop package must declare an explicit root file allowlist");
for (const path of ["!data/**", "!release/**", "!.git/**", "!.opengrove/**", "!.codex/**", "!.claude/**"]) {
  assert.ok(config.files.includes(path), `desktop package must exclude ${path}`);
}

const platformContracts = {
  mac: {
    own: "node_modules/@anthropic-ai/claude-agent-sdk-darwin-!(${arch})/**",
    foreign: ["win32", "linux"],
  },
  win: {
    own: "node_modules/@anthropic-ai/claude-agent-sdk-win32-!(${arch})/**",
    foreign: ["darwin", "linux"],
  },
  linux: {
    own: "node_modules/@anthropic-ai/claude-agent-sdk-linux-!(${arch})/**",
    foreign: ["darwin", "win32"],
  },
};

for (const [platform, contract] of Object.entries(platformContracts)) {
  const files = config[platform]?.files;
  assert.ok(Array.isArray(files), `${platform}.files must be explicit`);
  assert.ok(
    files.some((entry) => typeof entry === "string" && !entry.startsWith("!")),
    `${platform}.files needs a positive matcher so electron-builder does not prepend **/*`,
  );
  assert.ok(
    files.includes(`!${contract.own}`),
    `${platform}.files must drop other architectures of its own Claude runtime`,
  );
  for (const foreign of contract.foreign) {
    assert.ok(
      files.includes(`!node_modules/@anthropic-ai/claude-agent-sdk-${foreign}-*/**`),
      `${platform}.files must drop ${foreign} Claude runtimes`,
    );
  }
}

console.log("desktop runtime pruning contract: ok");
