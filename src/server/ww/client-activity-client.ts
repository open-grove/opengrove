import { record, stringValue } from "../http-utils.js";
import type { WwTransport } from "./transport.js";
import type { WwClientActivityClient } from "./types.js";

export function createWwClientActivityClient(transport: WwTransport): WwClientActivityClient {
  return {
    async recordClientActivity(accessToken, input) {
      const result = record(
        await transport.requestEnvelope<unknown>("/v1/client/activity", {
          method: "POST",
          accessToken,
          body: {
            surface: input.surface,
            operating_system: input.operatingSystem,
            architecture: input.architecture,
            client_version: input.clientVersion,
            ...(input.clientReleaseNumber === undefined ? {} : { client_release_number: input.clientReleaseNumber }),
            bridge_version: input.bridgeVersion,
            ...(input.bridgeReleaseNumber === undefined ? {} : { bridge_release_number: input.bridgeReleaseNumber }),
            release_channel: input.releaseChannel,
          },
        }),
      );
      const day = stringValue(result.day);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("ww_client_activity_response_invalid");
      return { day };
    },
  };
}
