#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODELS_DEV_REPOSITORY = "https://github.com/anomalyco/models.dev.git";
const MODELS_DEV_API = "https://models.dev/api.json";
const CATALOG_VERSION = 1;
const INCLUDED_PROVIDER_IDS = [
  "aihubmix",
  "alibaba-cn",
  "amazon-bedrock",
  "anthropic",
  "azure",
  "deepseek",
  "google",
  "google-vertex-anthropic",
  "minimax",
  "moonshotai-cn",
  "openai",
  "openrouter",
  "xai",
  "xiaomi",
  "zai",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const options = parseOptions(process.argv.slice(2));
const outputPath = resolve(options.output ?? join(projectRoot, "src/server/models-dev-catalog.generated.json"));
let temporarySource;

try {
  const sourceRoot = options.source ? resolve(options.source) : (temporarySource = cloneModelsDev());
  const api = await readApi(options.api);
  const sourceCommit = git(sourceRoot, ["rev-parse", "HEAD"]);
  const providers = Object.fromEntries(
    INCLUDED_PROVIDER_IDS.flatMap((providerId) => {
      const provider = api[providerId];
      if (!isRecord(provider) || !isRecord(provider.models)) return [];
      const models = Object.values(provider.models)
        .filter(isAgentModel)
        .sort(compareModels)
        .map((model) => compactModel(sourceRoot, providerId, model));
      return [
        [
          providerId,
          stripUndefined({
            id: providerId,
            name: stringValue(provider.name) || providerId,
            api: stringValue(provider.api) || undefined,
            env: stringArray(provider.env),
            doc: stringValue(provider.doc) || undefined,
            models,
          }),
        ],
      ];
    }),
  );
  const output = {
    version: CATALOG_VERSION,
    source: {
      repository: MODELS_DEV_REPOSITORY,
      commit: sourceCommit,
    },
    providers,
  };
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${relative(projectRoot, outputPath)} from Models.dev ${sourceCommit.slice(0, 12)}.`);
} finally {
  if (temporarySource) rmSync(temporarySource, { recursive: true, force: true });
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--source" || flag === "--api" || flag === "--output") {
      const value = args[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      parsed[flag.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }
  return parsed;
}

function cloneModelsDev() {
  const source = mkdtempSync(join(tmpdir(), "opengrove-models-dev-"));
  execFileSync("git", ["clone", "--depth", "1", MODELS_DEV_REPOSITORY, source], { stdio: "inherit" });
  return source;
}

async function readApi(input) {
  if (input && existsSync(resolve(input))) {
    return JSON.parse(readFileSync(resolve(input), "utf8"));
  }
  const response = await fetch(input || MODELS_DEV_API);
  if (!response.ok) throw new Error(`Models.dev API returned HTTP ${response.status}`);
  return response.json();
}

function compactModel(sourceRoot, providerId, model) {
  const id = stringValue(model.id);
  const canonicalModelId = canonicalModelIdFromSource(sourceRoot, providerId, id);
  return stripUndefined({
    id,
    name: stringValue(model.name) || id,
    family: stringValue(model.family) || undefined,
    canonicalModelId,
    status: stringValue(model.status) || undefined,
  });
}

function canonicalModelIdFromSource(sourceRoot, providerId, modelId) {
  const providerModelsRoot = join(sourceRoot, "providers", providerId, "models");
  const routePath = join(providerModelsRoot, ...modelId.split("/")) + ".toml";
  if (existsSync(routePath)) {
    const source = readFileSync(routePath, "utf8");
    const baseModel = /^base_model\s*=\s*"([^"]+)"\s*$/m.exec(source)?.[1]?.trim();
    if (baseModel) return baseModel;
  }
  const canonicalPath = join(sourceRoot, "models", providerId, ...modelId.split("/")) + ".toml";
  return existsSync(canonicalPath) ? `${providerId}/${modelId}` : undefined;
}

function isAgentModel(value) {
  if (!isRecord(value) || !stringValue(value.id) || value.tool_call !== true) return false;
  if (value.status === "deprecated") return false;
  const modalities = isRecord(value.modalities) ? value.modalities : {};
  return stringArray(modalities.input).includes("text") && stringArray(modalities.output).includes("text");
}

function compareModels(left, right) {
  const releaseOrder = stringValue(right.release_date).localeCompare(stringValue(left.release_date));
  return releaseOrder || stringValue(left.id).localeCompare(stringValue(right.id));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
