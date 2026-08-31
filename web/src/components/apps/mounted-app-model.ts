import type { ExtensionItemRecord } from "../../bridge";
import type { TranslationFn } from "../../i18n";

export type MountedAppPaneComponent = "file-tree" | "flow-list" | "dashboard" | "view";

export interface MountedAppPaneTab {
  id?: string;
  component: MountedAppPaneComponent;
  label: string;
  source?: Record<string, unknown>;
}

export type MountedAppSurface = "setup" | "file-workbench" | "view" | "none" | "unsupported";

export interface MountedAppUiRuntime {
  surface: MountedAppSurface;
  source: "surface" | "legacy-kind" | "missing";
  legacyKind?: string;
}

export interface MountedAppWorkbenchLayoutDefaults {
  filesWidth?: number;
  chatWidth?: number;
}

const MOUNTED_APP_PANE_COMPONENTS = new Set<MountedAppPaneComponent>(["file-tree", "flow-list", "dashboard", "view"]);

export function isMountedWorkbenchApp(item: ExtensionItemRecord): boolean {
  if (item.kind !== "app" || !item.enabled) return false;
  return mountedAppUiRuntime(item).surface !== "unsupported";
}

export function isMountedMcpApp(item: ExtensionItemRecord | undefined): boolean {
  return mountedAppUiRuntime(item).surface === "view";
}

export function mountedAppUiRuntime(item: ExtensionItemRecord | undefined): MountedAppUiRuntime {
  if (!item) return { surface: "unsupported", source: "missing" };
  const runtime = recordFromUnknown(item.metadata?.uiRuntime);
  const surface = normalizeMountedAppSurface(runtime.surface);
  if (surface) {
    return {
      surface,
      source: runtime.source === "surface" || runtime.source === "legacy-kind" ? runtime.source : "missing",
      ...(typeof runtime.legacyKind === "string" ? { legacyKind: runtime.legacyKind } : {}),
    };
  }
  return { surface: "unsupported", source: "missing" };
}

export function mountedAppMatchesId(app: ExtensionItemRecord, appId: string): boolean {
  if (!appId) return false;
  const source = recordFromUnknown(app.source);
  return app.name === appId || app.id === appId || app.id === `app:${appId}` || source.packageId === appId;
}

export function mountedAppSourcePath(app: ExtensionItemRecord): string {
  const sourcePath = typeof app.source?.path === "string" ? app.source.path : "";
  return sourcePath || String(app.deployments[0]?.targetPath || app.deployments[0]?.sourcePath || "");
}

export function mountedAppWorkspaceHint(app: ExtensionItemRecord): string {
  const ui = recordFromUnknown(app.metadata?.ui);
  const workspace = typeof ui.workspace === "string" && ui.workspace.trim() ? ui.workspace.trim() : "workspace";
  const root = mountedAppSourcePath(app);
  return root ? `${root}/${workspace}` : workspace;
}

export function resolveMountedAppWorkbenchLayoutDefaults(
  app: ExtensionItemRecord | undefined,
): MountedAppWorkbenchLayoutDefaults {
  const ui = recordFromUnknown(app?.metadata?.ui);
  const layout = recordFromUnknown(ui.workbenchLayout);
  return {
    ...finiteNumberProperty(layout, "filesWidth"),
    ...finiteNumberProperty(layout, "chatWidth"),
  };
}

export function resolveMountedAppTabs(app: ExtensionItemRecord | undefined, t: TranslationFn): MountedAppPaneTab[] {
  if (!app) return defaultMountedAppTabs(t);
  const ui = recordFromUnknown(app.metadata?.ui);
  const localizedTabs = recordFromUnknown(recordFromUnknown(app.metadata?.presentation).tabs);
  const tabs = Array.isArray(ui.tabs) ? ui.tabs : [];
  const resolved: MountedAppPaneTab[] = [];
  for (const tab of tabs) {
    const record = recordFromUnknown(tab);
    const component = normalizeMountedAppPaneComponent(record.component);
    if (!component) {
      if (record.component) console.warn("Unknown mounted app pane component", record.component);
      continue;
    }
    const id = stringFromUnknown(record.id);
    const localized = id ? recordFromUnknown(localizedTabs[id]) : {};
    if (component === "view" && !id) {
      console.warn("Mounted app View Tab is missing an id");
      continue;
    }
    const rawLabel = stringFromUnknown(localized.label) || stringFromUnknown(record.label);
    const label = rawLabel || defaultMountedAppTabLabel(component, t);
    resolved.push({
      ...(id ? { id } : {}),
      component,
      label,
      source: recordFromUnknown(record.source),
    });
  }
  return resolved.length ? resolved : defaultMountedAppTabs(t);
}

function defaultMountedAppTabs(t: TranslationFn): MountedAppPaneTab[] {
  return [
    { component: "file-tree", label: t("mountedApp.files") },
    { component: "flow-list", label: t("mountedApp.workflows") },
  ];
}

function defaultMountedAppTabLabel(component: MountedAppPaneComponent, t: TranslationFn): string {
  switch (component) {
    case "file-tree":
      return t("mountedApp.files");
    case "flow-list":
      return t("mountedApp.workflows");
    case "dashboard":
      return t("mountedApp.dashboard");
    case "view":
      return t("mountedApp.mcpAppTab");
  }
}

function normalizeMountedAppPaneComponent(value: unknown): MountedAppPaneComponent | undefined {
  const component = stringFromUnknown(value);
  if (component === "files") return "file-tree";
  if (component === "flows") return "flow-list";
  return MOUNTED_APP_PANE_COMPONENTS.has(component as MountedAppPaneComponent)
    ? (component as MountedAppPaneComponent)
    : undefined;
}

function finiteNumberProperty(
  value: Record<string, unknown>,
  key: keyof MountedAppWorkbenchLayoutDefaults,
): Partial<MountedAppWorkbenchLayoutDefaults> {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? { [key]: candidate } : {};
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringFromUnknown(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeMountedAppSurface(value: unknown): MountedAppSurface | undefined {
  return value === "setup" ||
    value === "file-workbench" ||
    value === "view" ||
    value === "none" ||
    value === "unsupported"
    ? value
    : undefined;
}
