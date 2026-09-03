export const BRIDGE_DISCOVERY_FILE_NAME = "bridge-info.json";

export interface BridgeDiscoveryInfo {
  url: string;
  apiUrl: string;
  host: string;
  port: number;
  pid: number;
  startedAt: string;
}
