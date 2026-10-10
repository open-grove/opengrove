import { PiSessionRepository, nativePiSessionId as nativeId } from "@open-grove/agent-host/compat/pi085";
import type { ExecutionEnv } from "pi-agent-core-legacy";
export const nativePiSessionId = (id: string): string => nativeId(id, "opengrove-session:");
export class NativePiSessionRepository extends PiSessionRepository {
  constructor(root?: string, cwd?: string, env?: ExecutionEnv) {
    super(root, cwd, env, "opengrove-session:");
  }
}
