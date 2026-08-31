export function compactIdentifier(value: unknown): string {
  const text = String(value || "");
  if (text.length <= 20) {
    return text;
  }
  return `${text.slice(0, 12)}...${text.slice(-6)}`;
}
