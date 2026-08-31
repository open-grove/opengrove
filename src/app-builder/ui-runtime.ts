export const APP_UI_SURFACES = ["setup", "file-workbench", "view", "none"] as const;

export type AppUiSurface = (typeof APP_UI_SURFACES)[number];
export type NormalizedAppUiSurface = AppUiSurface | "unsupported";

export interface McpAppViewConfig {
  protocol: "mcp-app";
  entry: string;
  tools: string[];
  csp: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  permissions: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
  };
}

export interface NormalizedAppUi {
  surface: NormalizedAppUiSurface;
  source: "surface" | "legacy-kind" | "missing";
  legacyKind?: string;
  view?: McpAppViewConfig;
}

export function normalizeAppUi(manifest: unknown): NormalizedAppUi {
  const ui = record(record(manifest).ui);
  const declaredSurface = stringValue(ui.surface);
  if (isAppUiSurface(declaredSurface)) {
    return {
      surface: declaredSurface,
      source: "surface",
      ...(declaredSurface === "view" ? { view: normalizeMcpAppView(ui.view) } : {}),
    };
  }
  return { surface: "unsupported", source: "missing" };
}

export function isOpenableAppUi(normalized: NormalizedAppUi): boolean {
  return normalized.surface !== "unsupported";
}

export function isAppUiSurface(value: unknown): value is AppUiSurface {
  return APP_UI_SURFACES.includes(value as AppUiSurface);
}

export function normalizeMcpAppView(value: unknown): McpAppViewConfig {
  const view = record(value);
  const csp = record(view.csp);
  const permissions = record(view.permissions);
  return {
    protocol: "mcp-app",
    entry: stringValue(view.entry),
    tools: stringArray(view.tools),
    csp: {
      ...optionalStringArray(csp, "connectDomains"),
      ...optionalStringArray(csp, "resourceDomains"),
      ...optionalStringArray(csp, "frameDomains"),
      ...optionalStringArray(csp, "baseUriDomains"),
    },
    permissions: {
      ...(isEmptyRecord(permissions.camera) ? { camera: {} } : {}),
      ...(isEmptyRecord(permissions.microphone) ? { microphone: {} } : {}),
      ...(isEmptyRecord(permissions.geolocation) ? { geolocation: {} } : {}),
      ...(isEmptyRecord(permissions.clipboardWrite) ? { clipboardWrite: {} } : {}),
    },
  };
}

function optionalStringArray(value: Record<string, unknown>, key: string): Record<string, string[]> {
  return Array.isArray(value[key]) ? { [key]: stringArray(value[key]) } : {};
}

function isEmptyRecord(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
