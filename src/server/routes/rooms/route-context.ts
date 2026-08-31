import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeSecurity } from "../../bridge-security.js";
import type { BridgeState } from "../../bridge-types.js";

export interface RoomsRouteInput {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  traceId?: string;
  state: BridgeState;
  security?: BridgeSecurity;
  sendJson: (response: ServerResponse, status: number, data: unknown) => void;
  readJsonBody: (request: IncomingMessage) => Promise<unknown>;
}

export type RoomsRouteContext = RoomsRouteInput;
