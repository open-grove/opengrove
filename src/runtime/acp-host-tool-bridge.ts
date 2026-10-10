import { AcpHostToolBridgeServer as SharedBridge } from "@open-grove/agent-host/acp";
import type { AgentHostToolScope } from "../core.js";
import type { HostToolBridge } from "./host-tool-bridge.js";
export { AcpHostToolBridgeUnavailableError } from "@open-grove/agent-host/acp";
export interface AcpHostToolSessionBinding {
  fingerprint: string;
  mcpServer: {
    type: "stdio";
    name: string;
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
  };
  activate(bridge: HostToolBridge): void;
  deactivate(bridge: HostToolBridge): void;
}

export interface AcpHostToolBridgeProvider {
  prepare(input: { scope: AgentHostToolScope; bridge: HostToolBridge }): Promise<AcpHostToolSessionBinding>;
  close(): void;
}

/** Product scope contributes to the capability fingerprint; transport belongs to Agent Host. */
export class AcpHostToolBridgeServer implements AcpHostToolBridgeProvider {
  private readonly bridge = new SharedBridge("opengrove", "OPENGROVE_ACP_HOST_TOOL");
  prepare(input: { scope: AgentHostToolScope; bridge: HostToolBridge }): Promise<AcpHostToolSessionBinding> {
    return this.bridge.prepare({
      scope: JSON.stringify({
        sessionId: input.scope.sessionId,
        employeeId: input.scope.employeeId ?? "",
        roomId: input.scope.roomId ?? "",
        tools: input.bridge.fingerprint,
      }),
      bridge: input.bridge,
    });
  }
  close(): void {
    this.bridge.close();
  }
}
