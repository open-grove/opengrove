const AUTH_COOKIE_PREFIX = "opengrove_auth_";

export type OpenGroveAuthSession = Readonly<{
  requestHeaders(): HeadersInit | Promise<HeadersInit>;
  updateFromResponse(response: Response): void | Promise<void>;
}>;

export type OpenGroveCookieAuthSession = OpenGroveAuthSession &
  Readonly<{
    snapshot(): Readonly<Record<string, string>>;
    clear(): Promise<void>;
  }>;

export type OpenGroveCookieAuthSessionOptions = Readonly<{
  cookies?: Readonly<Record<string, string>>;
  onChange?: (cookies: Readonly<Record<string, string>>) => void | Promise<void>;
}>;

/**
 * Keeps a Bridge cookie session in memory. Persistence deliberately stays with
 * the runtime adapter so browsers, desktop, and CLIs can use their native store.
 */
export function createCookieAuthSession(options: OpenGroveCookieAuthSessionOptions = {}): OpenGroveCookieAuthSession {
  const cookies = new Map(
    Object.entries(options.cookies ?? {}).filter(
      (entry): entry is [string, string] => isAuthCookie(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1]),
    ),
  );
  let updateQueue = Promise.resolve();

  const persist = async (): Promise<void> => {
    await options.onChange?.(cookieSnapshot(cookies));
  };

  return {
    requestHeaders() {
      const cookie = [...cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
      return cookie ? { cookie } : new Headers();
    },
    updateFromResponse(response) {
      const setCookies = responseSetCookies(response);
      updateQueue = updateQueue.then(async () => {
        let changed = false;
        for (const header of setCookies) {
          changed = applySetCookie(cookies, header) || changed;
        }
        if (changed) await persist();
      });
      return updateQueue;
    },
    snapshot() {
      return cookieSnapshot(cookies);
    },
    async clear() {
      if (cookies.size === 0) return;
      cookies.clear();
      await persist();
    },
  };
}

function applySetCookie(cookies: Map<string, string>, header: string): boolean {
  const pair = header.split(";", 1)[0] ?? "";
  const separator = pair.indexOf("=");
  if (separator <= 0) return false;
  const name = pair.slice(0, separator).trim();
  if (!isAuthCookie(name)) return false;
  const rawValue = pair.slice(separator + 1).trim();
  const expired = /(?:^|;)\s*max-age=0\s*(?:;|$)/iu.test(header);
  if (expired || !rawValue) return cookies.delete(name);
  const value = decodeCookieValue(rawValue);
  if (cookies.get(name) === value) return false;
  cookies.set(name, value);
  return true;
}

function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.();
  if (values?.length) return values;
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isAuthCookie(name: string): boolean {
  return name.startsWith(AUTH_COOKIE_PREFIX);
}

function cookieSnapshot(cookies: ReadonlyMap<string, string>): Readonly<Record<string, string>> {
  return Object.fromEntries(cookies);
}
