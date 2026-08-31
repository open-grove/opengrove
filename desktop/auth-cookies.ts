import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const AUTH_COOKIE_NAMES = new Set(["opengrove_auth_access", "opengrove_auth_refresh", "opengrove_auth_session"]);

export function responseSetCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  const values =
    typeof withGetter.getSetCookie === "function"
      ? withGetter.getSetCookie()
      : [headers.get("set-cookie")].filter((value): value is string => Boolean(value));
  return values.flatMap(splitCombinedSetCookieHeader);
}

type StoredCookie = {
  value: string;
  expiresAt?: number;
};

export class DesktopAuthCookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  constructor(private readonly storePath?: string) {
    this.load();
    this.persistIfChanged(this.pruneExpired());
  }

  applySetCookieHeaders(headers: readonly string[] | undefined): void {
    let changed = false;
    for (const header of headers ?? []) {
      const parsed = parseSetCookie(header);
      if (!parsed || !AUTH_COOKIE_NAMES.has(parsed.name)) continue;
      if (!parsed.value || (parsed.maxAge !== undefined && parsed.maxAge <= 0)) {
        changed = this.cookies.delete(parsed.name) || changed;
        continue;
      }
      this.cookies.set(parsed.name, {
        value: parsed.value,
        expiresAt: parsed.maxAge === undefined ? undefined : Date.now() + parsed.maxAge * 1000,
      });
      changed = true;
    }
    this.persistIfChanged(this.pruneExpired() || changed);
  }

  mergeRequestCookieHeader(header: string | undefined): string | undefined {
    this.persistIfChanged(this.pruneExpired());
    const merged = parseCookieHeader(header);
    for (const [name, cookie] of this.cookies) {
      merged.set(name, cookie.value);
    }
    if (merged.size === 0) return undefined;
    return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  hasSavedSession(): boolean {
    this.persistIfChanged(this.pruneExpired());
    return this.cookies.has("opengrove_auth_refresh");
  }

  clear(): void {
    if (this.cookies.size === 0) return;
    this.cookies.clear();
    this.persist();
  }

  private load(): void {
    const storePath = this.storePath;
    if (!storePath || !existsSync(storePath)) return;
    try {
      const data = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
      const cookies = recordValue(data).cookies;
      for (const [name, rawCookie] of Object.entries(recordValue(cookies))) {
        if (!AUTH_COOKIE_NAMES.has(name)) continue;
        const cookie = recordValue(rawCookie);
        const value = stringValue(cookie.value);
        if (!value) continue;
        const expiresAt = numberValue(cookie.expiresAt);
        this.cookies.set(name, {
          value,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
      }
    } catch (error) {
      const backupPath = `${storePath}.corrupt-${Date.now()}.bak`;
      renameSync(storePath, backupPath);
      console.warn("Desktop auth cookie store was invalid and has been quarantined.", {
        backupPath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.cookies.clear();
    }
  }

  private pruneExpired(): boolean {
    let changed = false;
    const now = Date.now();
    for (const [name, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(name);
        changed = true;
      }
    }
    return changed;
  }

  private persistIfChanged(changed: boolean): void {
    if (changed) this.persist();
  }

  private persist(): void {
    if (!this.storePath) return;
    if (this.cookies.size === 0) {
      rmSync(this.storePath, { force: true });
      return;
    }
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(
      this.storePath,
      JSON.stringify({
        version: 1,
        cookies: Object.fromEntries(this.cookies),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

function parseSetCookie(header: string): { name: string; value: string; maxAge?: number } | undefined {
  const parts = header.split(";").map((part) => part.trim());
  const [nameValue, ...attributes] = parts;
  if (!nameValue) return undefined;
  const separator = nameValue.indexOf("=");
  if (separator <= 0) return undefined;
  const maxAge = attributes
    .map((attribute) => attribute.match(/^max-age=(-?\d+)$/i)?.[1])
    .find((value): value is string => value !== undefined);
  return {
    name: nameValue.slice(0, separator),
    value: nameValue.slice(separator + 1),
    maxAge: maxAge === undefined ? undefined : Number(maxAge),
  };
}

function splitCombinedSetCookieHeader(header: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  for (let index = 0; index < header.length; index += 1) {
    if (header[index] !== ",") continue;
    let candidateStart = index + 1;
    while (candidateStart < header.length && /\s/u.test(header[candidateStart] ?? "")) candidateStart += 1;
    const equals = header.indexOf("=", candidateStart);
    const semicolon = header.indexOf(";", candidateStart);
    const comma = header.indexOf(",", candidateStart);
    if (equals >= 0 && (semicolon < 0 || equals < semicolon) && (comma < 0 || equals < comma)) {
      const cookie = header.slice(start, index).trim();
      if (cookie) cookies.push(cookie);
      start = candidateStart;
    }
  }
  const cookie = header.slice(start).trim();
  if (cookie) cookies.push(cookie);
  return cookies;
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
