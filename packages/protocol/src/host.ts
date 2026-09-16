import { clientBootstrapSchema } from "./client-bootstrap.js";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { hostRequestErrors } from "./host-errors.js";

export const getHostBootstrapOperation = defineHostOperation({
  id: "host.host.bootstrap",
  summary: "Read Host startup configuration",
  description:
    "Discover the Host identity, runtime environment, authentication requirements, and MCP App sandbox origin.",
  method: "GET",
  path: "/bootstrap",
  risk: "read",
  success: { status: 200, body: clientBootstrapSchema },
  errors: hostRequestErrors,
});
export type GetHostBootstrapOperation = typeof getHostBootstrapOperation;
export const hostOperationGroup = defineHostOperationGroup({
  id: "host",
  title: "Host",
  description: "Discover and diagnose the running Host.",
  resources: [
    defineHostOperationResource({
      id: "host",
      title: "Host discovery",
      description: "Inspect Host identity and environment.",
      operations: [getHostBootstrapOperation] as const,
    }),
  ] as const,
});
