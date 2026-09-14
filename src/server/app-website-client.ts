import { z } from "zod";
import { appWebsiteSiteSchema, type AppWebsiteSite } from "#protocol";
import type { ReleaseControlConfig } from "./release-control-config.js";

export class AppWebsiteRemoteError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
export async function requestAppWebsite(
  config: ReleaseControlConfig,
  path: string,
  body?: unknown,
): Promise<AppWebsiteSite> {
  const response = await fetch(config.baseUrl.replace(/\/$/, "") + "/v1/app-websites/" + path, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: { Authorization: "Bearer " + config.accessToken, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(body === undefined ? 30_000 : 5 * 60_000),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new AppWebsiteRemoteError("website_response_invalid", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 256 * 1024) throw new AppWebsiteRemoteError("website_response_invalid", 502);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppWebsiteRemoteError("website_response_invalid", 502);
  }
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(value);
    const code =
      parsed.success && /^(website_|release_control_)[a-z_]+$/.test(parsed.data.error)
        ? parsed.data.error
        : "website_service_unavailable";
    const status = [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504].includes(response.status)
      ? response.status
      : 502;
    throw new AppWebsiteRemoteError(code, status);
  }
  const parsed = z.object({ site: appWebsiteSiteSchema }).safeParse(value);
  if (!parsed.success) throw new AppWebsiteRemoteError("website_response_invalid", 502);
  return parsed.data.site;
}
