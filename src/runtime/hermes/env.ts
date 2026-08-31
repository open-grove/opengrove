export function mergeRuntimeEnv(
  base: NodeJS.ProcessEnv | undefined,
  override: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  const merged = { ...(base ?? {}), ...(override ?? {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return Object.keys(merged).length ? merged : undefined;
}

export function envFingerprint(env: NodeJS.ProcessEnv | undefined): string {
  return Object.entries(env ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .filter(([key]) => !isVolatileOpenGroveRuntimeEnvKey(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function isVolatileOpenGroveRuntimeEnvKey(key: string): boolean {
  return key === "OPENGROVE_ROOM_LEDGER_CAPABILITY_JSON" || key === "OPENGROVE_SOURCE_ROOM_ID";
}
