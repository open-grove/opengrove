import { bindOpenGroveClient, type OpenGroveClient } from "./generated/client.js";
import { createHostOperationRequest, type OpenGroveClientConfig } from "./transport.js";

export type { OpenGroveClient } from "./generated/client.js";
export { openGroveClientOperationIds } from "./generated/client.js";
export type {
  HostOperationCall,
  HostOperationRequest,
  OpenGroveClientConfig,
  OpenGroveRequestOptions,
} from "./transport.js";

export function createOpenGroveClient(config: OpenGroveClientConfig = {}): OpenGroveClient {
  return bindOpenGroveClient(createHostOperationRequest(config));
}
