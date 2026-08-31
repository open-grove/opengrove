export function normalizeAppStorePackageKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let normalized = value.toLowerCase().replace(/^[ \t\r\n/]+|[ \t\r\n/]+$/g, "");
  normalized = normalized.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..") || normalized.includes("/")) return undefined;
  return normalized;
}

export function normalizeArchiveSha256(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

export function normalizeAppStoreRegistryUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return undefined;
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/g, "");
    return `${parsed.origin}${pathname && pathname !== "/" ? pathname : ""}${parsed.search}`;
  } catch {
    return undefined;
  }
}

export function appStoreRegistryUrlFromPackageRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hashIndex = value.lastIndexOf("#");
  if (hashIndex <= 0) return undefined;
  return normalizeAppStoreRegistryUrl(value.slice(0, hashIndex));
}

// registry URL 不参与身份:它只是传输通道,官方地址每次变更(IP→域名、http→https)都不应
// 使已安装 App 变成"来源冲突"。发布者归属由 ww 服务端在发布时校验 packageKey 前缀保证。
export function appStorePackageSourceIdentity(input: {
  packageKey?: unknown;
  packageRef?: unknown;
  registryUrl?: unknown;
}): string | undefined {
  const packageKey = normalizeAppStorePackageKey(input.packageKey);
  const packageRef = typeof input.packageRef === "string" ? input.packageRef.trim() : "";
  let refPackageKey: string | undefined;
  if (packageRef) {
    const hashIndex = packageRef.lastIndexOf("#");
    if (hashIndex < 0) return undefined;
    refPackageKey = normalizeAppStorePackageKey(packageRef.slice(hashIndex + 1));
    if (!refPackageKey) return undefined;
  }
  const resolvedPackageKey = packageKey ?? refPackageKey;
  if (!resolvedPackageKey || (refPackageKey && refPackageKey !== resolvedPackageKey)) {
    return undefined;
  }
  return resolvedPackageKey;
}
