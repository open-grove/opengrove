export function internalBridgeBaseUrl(host: string, port: number): string {
  const normalizedHost = host.trim().toLowerCase();
  const connectHost =
    normalizedHost === "0.0.0.0"
      ? "127.0.0.1"
      : normalizedHost === "::" || normalizedHost === "[::]"
        ? "::1"
        : host.trim();
  const urlHost = connectHost.includes(":") && !connectHost.startsWith("[") ? `[${connectHost}]` : connectHost;
  return `http://${urlHost}:${port}`;
}
