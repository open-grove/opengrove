export function providerUnavailableReason(reason: string | undefined): string | undefined {
  const normalized = reason?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const unavailablePatterns = [
    /no inference provider configured/i,
    /provider is not configured/i,
    /no api key for provider/i,
    /api key not found/i,
    /api client not configured/i,
    /no auth type is selected/i,
    /missing .*api key/i,
    /does not have a valid .*subscription/i,
    /subscription (?:has )?expired/i,
    /insufficient (?:balance|credits|quota)/i,
    /account .* (?:suspended|disabled)/i,
  ];
  return unavailablePatterns.some((pattern) => pattern.test(normalized)) ? normalized : undefined;
}
