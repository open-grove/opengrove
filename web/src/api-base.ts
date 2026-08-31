type ApiBaseGlobal = typeof globalThis & {
  __OPENGROVE_API_BASE__?: string;
  openGroveDesktop?: {
    apiBase?: string;
  };
};

export function apiUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return path;
  }

  const base = readApiBase();
  if (!base) {
    return path;
  }

  const normalizedBase = ensureTrailingSlash(base.trim());
  const relativePath = path.replace(/^\/+/, "");
  const absoluteBase = absoluteApiBase(normalizedBase);
  if (absoluteBase) {
    if (isBridgeStaticPath(path)) {
      const baseUrl = new URL(absoluteBase);
      return new URL(relativePath, `${baseUrl.protocol}//${baseUrl.host}/`).toString();
    }
    return new URL(relativePath, absoluteBase).toString();
  }
  return `${normalizedBase}${relativePath}`;
}

function isBridgeStaticPath(path: string): boolean {
  return path.startsWith("/generated/") || path.startsWith("/vault-file/");
}

function readApiBase(): string | undefined {
  const globalBase = (globalThis as ApiBaseGlobal).__OPENGROVE_API_BASE__;
  if (typeof globalBase === "string" && globalBase.trim()) {
    return globalBase.trim();
  }

  const desktopBase = (globalThis as ApiBaseGlobal).openGroveDesktop?.apiBase;
  if (typeof desktopBase === "string" && desktopBase.trim()) {
    return desktopBase.trim();
  }

  if (typeof document !== "undefined") {
    const metaBase = document.querySelector<HTMLMetaElement>('meta[name="opengrove-api-base"]')?.content.trim();
    if (metaBase) {
      return metaBase;
    }
  }

  return undefined;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function absoluteApiBase(base: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(base)) {
    return base;
  }

  const origin = currentOrigin();
  if (!origin) {
    return undefined;
  }

  return new URL(base, base.startsWith("/") ? origin : (globalThis.location?.href ?? origin)).toString();
}

function currentOrigin(): string | undefined {
  const origin = globalThis.location?.origin;
  return origin && origin !== "null" ? origin : undefined;
}
