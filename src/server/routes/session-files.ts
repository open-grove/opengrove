import { hostContractById } from "#protocol/compiled";
import type { HostOperationRouteContext, BridgeRoute } from "../router.js";
import type { listWorkspaceFilesOperation, readWorkspaceFileOperation, writeWorkspaceFileOperation } from "#protocol";
import { LocalFilesystemWorkspaceStore, safeResolveInside } from "../workspace-store.js";
import { WorkspaceFileConflict } from "../workspace-file-revision.js";
import { operationRoute } from "./registry-utils.js";

type FileOperation =
  | typeof listWorkspaceFilesOperation
  | typeof readWorkspaceFileOperation
  | typeof writeWorkspaceFileOperation;
const files = new LocalFilesystemWorkspaceStore();
export function createSessionFileRoutes(): BridgeRoute[] {
  return [
    operationRoute(hostContractById["workspace.file.list"], handleSessionFiles),
    operationRoute(hostContractById["workspace.file.read"], handleSessionFiles),
    operationRoute(hostContractById["workspace.file.write"], handleSessionFiles),
  ];
}
function handleSessionFiles(context: HostOperationRouteContext<FileOperation>): true {
  const sessionId = context.input.params.sessionId;
  const binding = context.state.app.sessions.get(sessionId)?.metadata?.integrationSession;
  const root = binding && typeof binding === "object" && !Array.isArray(binding) ? binding.workspaceRoot : undefined;
  if (typeof root !== "string") {
    context.sendJson(context.response, 404, { ok: false, error: "session_workspace_not_found" });
    return true;
  }
  const scope = { kind: "local" as const, appId: sessionId, root };
  const path = context.input.body?.path ?? context.input.query?.path ?? "";
  if (!safeResolveInside(root, path)) {
    context.sendJson(context.response, 403, { ok: false, error: "workspace_path_outside_root" });
    return true;
  }
  try {
    if (context.input.body) {
      const result = files.writeFile(scope, path, context.input.body.content, {
        expectedRevision: context.input.body.expectedRevision,
      });
      if (!result) context.sendJson(context.response, 403, { ok: false, error: "workspace_path_outside_root" });
      else context.sendJson(context.response, 200, { ok: true, file: result });
    } else if (context.operation.id === "workspace.file.list") {
      context.sendJson(context.response, 200, { ok: true, ...files.listFiles(scope, context.input.query) });
    } else {
      const result = files.readFile(scope, path, {
        textSizeLimit:
          context.input.query && "maxBytes" in context.input.query ? context.input.query.maxBytes : 500_000,
      });
      if (!result) context.sendJson(context.response, 404, { ok: false, error: "workspace_file_not_found" });
      else context.sendJson(context.response, 200, { ok: true, file: result });
    }
  } catch (error) {
    if (!(error instanceof WorkspaceFileConflict)) throw error;
    context.sendJson(context.response, error.status, { ok: false, error: error.message });
  }
  return true;
}
