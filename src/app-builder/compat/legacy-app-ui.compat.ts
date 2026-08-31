import { normalizeAppUi, normalizeMcpAppView, type NormalizedAppUi } from "../ui-runtime.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 ui.kind=file-workbench and ui.kind=mcp-app manifests.
 * Remove when: direct upgrades from OpenGrove <=0.6.1 move to the standalone importer.
 */
export const MCP_APP_MIGRATION_GUIDE = "docs/product/OPENGROVE_APP_SPEC.md#ui-strategy";

export function normalizeCompatibleAppUi(manifest: unknown): NormalizedAppUi {
  const current = normalizeAppUi(manifest);
  if (current.source !== "missing") return current;

  const ui = record(record(manifest).ui);
  const kind = legacyAppUiKind(manifest);
  if (kind === "file-workbench") {
    return { surface: "file-workbench", source: "legacy-kind", legacyKind: kind };
  }
  if (kind === "mcp-app") {
    return {
      surface: "view",
      source: "legacy-kind",
      legacyKind: kind,
      view: normalizeMcpAppView({ ...ui, protocol: "mcp-app" }),
    };
  }
  return kind ? { surface: "unsupported", source: "legacy-kind", legacyKind: kind } : current;
}

export function legacyAppUiKind(manifest: unknown): string {
  return stringValue(record(record(manifest).ui).kind);
}

export function retiredWebAppUiIssue(manifest: unknown): string | undefined {
  const kind = legacyAppUiKind(manifest);
  if (kind !== "web-app" && kind !== "web") return undefined;
  return `ui.kind=${kind} is no longer supported; migrate this App to ui.surface=view with ui.view.protocol=mcp-app; see ${MCP_APP_MIGRATION_GUIDE}`;
}

export function mountedAppUiMigrationRequired(manifest: unknown): boolean {
  const kind = legacyAppUiKind(manifest);
  return kind === "file-workbench" || kind === "mcp-app";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
