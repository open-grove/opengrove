import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { z } from "zod";
import { roomMemberInputSchema, roomMemberSchema, roomMemberPatchSchema } from "./room-members.js";
import { createRoomMessageOperation } from "./rooms.js";

export const upsertEmployeeOperation = defineHostOperation({
  id: "employee.employee.upsert",
  summary: "Create or replace an Employee",
  description:
    "Create or replace local Employee metadata. Existing remote bindings and server-owned App defaults are preserved.",
  method: "POST",
  path: "/rooms/members",
  risk: "write",
  body: roomMemberInputSchema,
  success: {
    status: 200,
    body: z.object({ ok: z.literal(true), member: roomMemberSchema, currentEventSeq: z.number().int().nonnegative() }),
  },
  errors: createRoomMessageOperation.errors,
});
export type UpsertEmployeeOperation = typeof upsertEmployeeOperation;

export const updateEmployeeOperation = defineHostOperation({
  id: "employee.employee.update",
  summary: "Update Employee preferences",
  description:
    "Change selected Employee fields. Explicit null clears a preference; App-managed defaults and remote Employee restrictions remain authoritative.",
  method: "PATCH",
  path: "/rooms/members/{memberId}",
  risk: "write",
  params: z.object({ memberId: z.string().trim().min(1) }),
  body: roomMemberPatchSchema,
  success: upsertEmployeeOperation.success,
  errors: upsertEmployeeOperation.errors,
});
export type UpdateEmployeeOperation = typeof updateEmployeeOperation;

export const restoreEmployeeDefaultsOperation = defineHostOperation({
  id: "employee.employee.restore-defaults",
  summary: "Restore App Employee defaults",
  description:
    "Restore App-owned Employee fields from the installed App's defaults while preserving the user's Provider choice and App instructions.",
  method: "POST",
  path: "/rooms/members/{memberId}/restore-app-defaults",
  risk: "write",
  params: z.object({ memberId: z.string().trim().min(1) }),
  success: upsertEmployeeOperation.success,
  errors: upsertEmployeeOperation.errors,
});
export type RestoreEmployeeDefaultsOperation = typeof restoreEmployeeDefaultsOperation;

export const employeeOperationGroup = defineHostOperationGroup({
  id: "employee",
  title: "Employees",
  description: "Employee identity, runtime preferences, and App defaults.",
  resources: [
    defineHostOperationResource({
      id: "employee",
      title: "Employees",
      description: "Manage Employee metadata.",
      operations: [upsertEmployeeOperation, updateEmployeeOperation, restoreEmployeeDefaultsOperation] as const,
    }),
  ] as const,
});
