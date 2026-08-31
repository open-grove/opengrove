import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { APP_MANAGED_BY } from "../identity.js";
import type { JsonObject } from "../core.js";
import type { ExtensionRootDescriptor } from "./kernel-roots.js";
import type { ExtensionSourceOrigin } from "./types.js";
import { stringValue, titleFromName } from "./scanner-helpers.js";

export interface PluginEntry {
  name: string;
  title: string;
  description: string;
  manifestPath: string;
  pluginRoot: string;
  enabled: boolean;
  sourceOrigin: ExtensionSourceOrigin;
  metadata: JsonObject;
}

export function discoverPlugins(
  root: ExtensionRootDescriptor,
  parseConfig: (path: string, format: string | undefined) => JsonObject | undefined,
  shouldSkipDirectory: (name: string) => boolean,
): PluginEntry[] {
  const output: PluginEntry[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (depth > (root.maxDepth ?? 4)) return;
    if (seen.has(dir)) return;
    seen.add(dir);
    const manifest = findPluginManifest(dir);
    if (manifest) {
      const parsed = parseConfig(manifest.path, "jsonc") ?? {};
      const name = stringValue(parsed.name) || stringValue(parsed.id) || basename(pluginRootForManifest(manifest.path));
      output.push({
        name,
        title: stringValue(parsed.title) || stringValue(parsed.displayName) || titleFromName(name),
        description: stringValue(parsed.description) || "",
        manifestPath: manifest.path,
        pluginRoot: pluginRootForManifest(manifest.path),
        enabled: manifest.enabled,
        sourceOrigin: stringValue(parsed.managedBy) === APP_MANAGED_BY ? "opengrove" : root.sourceOrigin,
        metadata: parsed,
      });
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) continue;
      visit(join(dir, entry.name), depth + 1);
    }
  };
  visit(root.path, 0);
  return output.sort((left, right) => left.name.localeCompare(right.name));
}

function findPluginManifest(dir: string): { path: string; enabled: boolean } | undefined {
  const candidates = [
    "plugin.json",
    "plugin.json.disabled",
    "manifest.json",
    "manifest.json.disabled",
    join(".codex-plugin", "plugin.json"),
    join(".codex-plugin", "plugin.json.disabled"),
    join(".claude-plugin", "plugin.json"),
    join(".claude-plugin", "plugin.json.disabled"),
  ];
  for (const candidate of candidates) {
    const path = join(dir, candidate);
    if (existsSync(path)) {
      return { path, enabled: !path.endsWith(".disabled") };
    }
  }
  return undefined;
}

function pluginRootForManifest(path: string): string {
  const parent = dirname(path);
  const parentName = basename(parent);
  if (parentName === ".codex-plugin" || parentName === ".claude-plugin" || parentName === ".plugin") {
    return dirname(parent);
  }
  return parent;
}
