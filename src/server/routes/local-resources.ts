import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openLocalPath } from "../../local-path-actions.js";
import { record, stringValue } from "../http-utils.js";
import type { BridgeRouteContext } from "../router.js";

const DEFAULT_MAX_REVEALS_PER_WINDOW = 4;
const DEFAULT_REVEAL_WINDOW_MS = 2_000;

interface LocalResourceRouteDependencies {
  reveal(path: string): Promise<void>;
  revealGate?: LocalResourceRevealGate;
  realpath?(path: string): Promise<string>;
}

const defaultDependencies: LocalResourceRouteDependencies = {
  reveal: (path) => openLocalPath(path, "reveal"),
};

export interface LocalResourceRevealGate {
  run(action: () => Promise<void>): Promise<void>;
}

interface LocalResourceRevealGateOptions {
  maxStarts?: number;
  windowMs?: number;
  now?: () => number;
}

class LocalResourceRateLimitError extends Error {
  constructor() {
    super("local_resource_rate_limited");
  }
}

export function createLocalResourceRevealGate(options: LocalResourceRevealGateOptions = {}): LocalResourceRevealGate {
  const maxStarts = options.maxStarts ?? DEFAULT_MAX_REVEALS_PER_WINDOW;
  const windowMs = options.windowMs ?? DEFAULT_REVEAL_WINDOW_MS;
  const now = options.now ?? Date.now;
  const starts: number[] = [];
  let active = false;
  return {
    async run(action) {
      const current = now();
      while (starts[0] !== undefined && current - starts[0] >= windowMs) starts.shift();
      if (active || starts.length >= maxStarts) throw new LocalResourceRateLimitError();
      active = true;
      starts.push(current);
      try {
        await action();
      } finally {
        active = false;
      }
    },
  };
}

const defaultRevealGate = createLocalResourceRevealGate();

export async function handleLocalResourceRoute(
  context: BridgeRouteContext,
  dependencies: LocalResourceRouteDependencies = defaultDependencies,
): Promise<boolean> {
  const { request, response, url, state, sendJson } = context;
  if (!url.pathname.startsWith("/local-resource")) return false;

  if (url.pathname !== "/local-resource/reveal") {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return true;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }
  if (state.profile !== "local") {
    sendJson(response, 501, { ok: false, error: "local_resource_unsupported_for_profile" });
    return true;
  }

  try {
    const body = record(await context.readJsonBody(request));
    const requestedPath = stringValue(body.path).trim();
    if (!requestedPath || !isAbsolute(requestedPath)) {
      sendJson(response, 400, { ok: false, error: "local_resource_absolute_path_required" });
      return true;
    }

    let existingPath: string;
    try {
      existingPath = await (dependencies.realpath ?? realpath)(requestedPath);
    } catch {
      sendJson(response, 404, { ok: false, error: "local_resource_not_found" });
      return true;
    }

    await (dependencies.revealGate ?? defaultRevealGate).run(() => dependencies.reveal(existingPath));
    sendJson(response, 200, { ok: true, target: "file-manager" });
  } catch (error) {
    if (error instanceof LocalResourceRateLimitError) {
      sendJson(response, 429, { ok: false, error: error.message });
      return true;
    }
    sendJson(response, 500, { ok: false, error: "local_resource_reveal_failed" });
  }
  return true;
}
