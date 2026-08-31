import { numberValue, record, stringValue } from "../http-utils.js";
import type { WwTransport } from "./transport.js";
import type { WwClientPlatformVersion, WwClientUpdateClient, WwLatestClientVersion } from "./types.js";

export function createWwClientUpdateClient(transport: WwTransport): WwClientUpdateClient {
  return {
    readPublicLatestClientVersion() {
      return transport.requestJson(
        "/v1/public/client/latest-version",
        {
          method: "GET",
        },
        mapLatestClientVersion,
      );
    },
    readLatestClientVersion(accessToken) {
      // This endpoint intentionally returns raw version JSON instead of the
      // standard WW data/request_id envelope.
      return transport.requestJson(
        "/v1/client/latest-version",
        {
          method: "GET",
          accessToken,
        },
        mapLatestClientVersion,
      );
    },
  };
}

function mapLatestClientVersion(input: unknown): WwLatestClientVersion {
  const object = record(input);
  return {
    mac: mapClientPlatformVersion(object.mac),
    macArm64: mapClientPlatformVersion(object.mac_arm64),
    macX64: mapClientPlatformVersion(object.mac_x64),
    windows: mapClientPlatformVersion(object.windows),
    windowsX64: mapClientPlatformVersion(object.windows_x64),
    linux: mapClientPlatformVersion(object.linux),
    linuxX64: mapClientPlatformVersion(object.linux_x64),
    linuxArm64: mapClientPlatformVersion(object.linux_arm64),
  };
}

function mapClientPlatformVersion(input: unknown): WwClientPlatformVersion | undefined {
  const object = record(input);
  const version = numberValue(object.version);
  const downloadUrl = stringValue(object.download_url);
  if (version === undefined || !downloadUrl) return undefined;
  return {
    version,
    downloadUrl,
    updaterBaseUrl: stringValue(object.updater_base_url) || undefined,
    updaterFeedUrl: stringValue(object.updater_feed_url) || undefined,
    releasedAt: stringValue(object.released_at) || undefined,
    releaseNotes: stringValue(object.release_notes) || undefined,
  };
}
