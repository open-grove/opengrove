import { PiSessionRepository, nativePiSessionId as nativeId } from "@open-grove/agent-host/pi";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
export const nativePiSessionId = (id: string): string => nativeId(id, "opengrove-session:");
export class NativePiSessionRepository extends PiSessionRepository {
  constructor(root?: string, cwd?: string, env?: ExecutionEnv) {
    super(root, cwd, env, "opengrove-session:");
  }
}
