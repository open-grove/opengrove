import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FlowFrontmatter, FlowStep } from "../app-builder/flow.js";
import { parseFlowMarkdown, serializeFlowMarkdown } from "../app-builder/flow.js";
import type { JsonValue, Routine, RoutineStep } from "../core.js";
import type { KnowledgeDocument } from "../knowledge/types.js";
import type { RoutineRunStatusObserver, RoutineStepActivityRef } from "../routines/routine-runner.js";
import { workflowKnowledgeInitiator } from "../tools/workflow.js";
import { safePathSegment } from "./knowledge-path-utils.js";
import type { BridgeState } from "./bridge-types.js";
import { resolveMountedAppTarget, type MountedAppTarget } from "./mounted-apps.js";
import { appScopedRoomComponent } from "./app-room-ids.js";

const STEP_OUTPUT_LIMIT = 2_048;

interface FlowInstance {
  workspaceRoot: string;
  filePath: string;
  frontmatter: FlowFrontmatter;
}

interface FlowObserverTarget {
  workspaceRoot: string;
  initiator?: string;
}

type FlowObserverTargetResolver = (routine: Routine) => FlowObserverTarget | undefined;
type FlowInitiatorResolver = (routine: Routine) => string | undefined;

export interface RoutineFlowInstanceObserverOptions {
  initiator?: string | FlowInitiatorResolver;
}

export function createRoutineFlowInstanceObserver(
  state: BridgeState,
  options: RoutineFlowInstanceObserverOptions = {},
): RoutineRunStatusObserver {
  return createRoutineFlowInstanceObserverWithTarget(
    (routine) => resolveRoutineFlowObserverTarget(state, routine),
    options,
  );
}

export function createRoutineFlowInstanceObserverForWorkspace(
  workspaceRoot: string,
  options: RoutineFlowInstanceObserverOptions = {},
): RoutineRunStatusObserver {
  return createRoutineFlowInstanceObserverWithTarget(() => ({ workspaceRoot }), options);
}

function createRoutineFlowInstanceObserverWithTarget(
  resolveTarget: FlowObserverTargetResolver,
  options: RoutineFlowInstanceObserverOptions,
): RoutineRunStatusObserver {
  let instance: FlowInstance | undefined;

  return {
    async onRunStart({ routine, runId, startedAt }) {
      instance = ensureInstance(resolveTarget, options, instance, routine, runId, startedAt);
      if (!instance) return;
      instance.frontmatter.status = "running";
      instance.frontmatter.started = startedAt;
      instance.frontmatter.updated = startedAt;
      writeFlowInstance(instance);
    },
    async onStepStatus({ routine, runId, step, status, output, error, activityRef, at }) {
      instance = ensureInstance(resolveTarget, options, instance, routine, runId, at);
      if (!instance) return;
      const target = instance.frontmatter.steps.find((candidate) => candidate.id === step.id);
      if (!target) return;
      target.status = status === "waiting" ? "waiting" : status;
      if (step.flowApproval) {
        target.owner = "user";
        target.blocking = true;
      }
      if (activityRef) {
        writeActivityRef(target, activityRef);
      }
      if (output !== undefined) {
        target.output = summarizeStepOutput(output);
        const outputActivityRef = activityReferenceFromOutput(output);
        if (outputActivityRef) writeActivityRef(target, outputActivityRef);
      }
      if (error) {
        target.note = error;
      }
      instance.frontmatter.status =
        status === "failed"
          ? "failed"
          : status === "waiting"
            ? "waiting_user"
            : instance.frontmatter.status === "waiting_user"
              ? "running"
              : instance.frontmatter.status;
      instance.frontmatter.updated = at;
      writeFlowInstance(instance);
    },
    async onRunFinish({ routine, summary, at }) {
      instance = ensureInstance(resolveTarget, options, instance, routine, summary.id, at);
      if (!instance) return;
      instance.frontmatter.status = routineRunStatusToFlowStatus(summary.status);
      instance.frontmatter.updated = summary.endedAt ?? at;
      writeFlowInstance(instance);
    },
  };
}

function ensureInstance(
  resolveTarget: FlowObserverTargetResolver,
  options: RoutineFlowInstanceObserverOptions,
  current: FlowInstance | undefined,
  routine: Routine,
  runId: string,
  startedAt: string,
): FlowInstance | undefined {
  const target = resolveTarget(routine);
  if (!target) return undefined;
  const workspaceRoot = target.workspaceRoot;
  const filePath = routineFlowInstancePath(workspaceRoot, routine, runId);
  if (current?.filePath === filePath) return current;
  const existing = readExistingFlowInstance(filePath);
  if (existing) {
    return { workspaceRoot, filePath, frontmatter: existing };
  }
  return {
    workspaceRoot,
    filePath,
    frontmatter: {
      flow: "v1",
      title: routine.title,
      status: "running",
      initiator: resolveFlowInitiator(options, routine, target),
      started: startedAt,
      updated: startedAt,
      steps: routine.steps.map(flowStepForRoutineStep),
    },
  };
}

function readExistingFlowInstance(filePath: string): FlowFrontmatter | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = parseFlowMarkdown(readFileSync(filePath, "utf8"));
    return parsed.valid ? parsed.frontmatter : undefined;
  } catch {
    return undefined;
  }
}

function routineFlowInstancePath(workspaceRoot: string, routine: Routine, runId: string): string {
  return resolve(workspaceRoot, "runs", `${safePathSegment(routine.id)}-${safePathSegment(runId)}.flow.md`);
}

function flowStepForRoutineStep(step: RoutineStep): FlowStep {
  return {
    id: step.id,
    title: step.title,
    owner: step.flowApproval ? "user" : (step.memberId ?? step.toolId ?? "runner"),
    status: "pending",
  };
}

function routineRunStatusToFlowStatus(status: string): FlowFrontmatter["status"] {
  if (status === "succeeded") return "done";
  if (status === "failed") return "failed";
  if (status === "paused_for_approval") return "waiting_user";
  return "running";
}

function writeFlowInstance(instance: FlowInstance): void {
  mkdirSync(dirname(instance.filePath), { recursive: true });
  writeFileSync(instance.filePath, serializeFlowMarkdown(instance.frontmatter), "utf8");
}

function summarizeStepOutput(output: JsonValue): string {
  const text = typeof output === "string" ? output : safeJson(output);
  return text.length <= STEP_OUTPUT_LIMIT
    ? text
    : `${text.slice(0, STEP_OUTPUT_LIMIT)}...(truncated ${text.length} chars)`;
}

function safeJson(value: JsonValue): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function activityReferenceFromOutput(
  output: JsonValue,
): { runId: string; messageId: string; roomId: string } | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const record = output as Record<string, JsonValue>;
  const runId = stringJsonValue(record.runId);
  const messageId = stringJsonValue(record.messageId);
  const roomId = stringJsonValue(record.roomId);
  return runId && messageId && roomId ? { runId, messageId, roomId } : undefined;
}

function writeActivityRef(step: FlowStep, activityRef: RoutineStepActivityRef): void {
  step.activityRunId = activityRef.runId;
  step.messageId = activityRef.messageId;
  step.roomId = activityRef.roomId;
}

function stringJsonValue(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringMetadata(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function resolveFlowInitiator(
  options: RoutineFlowInstanceObserverOptions,
  routine: Routine,
  target: FlowObserverTarget,
): string {
  if (typeof options.initiator === "function") {
    return options.initiator(routine) || `routine:${routine.id}`;
  }
  return options.initiator || target.initiator || `routine:${routine.id}`;
}

function resolveRoutineFlowObserverTarget(state: BridgeState, routine: Routine): FlowObserverTarget | undefined {
  const workflowTarget = resolveRoutineWorkflowTarget(state, routine);
  if (workflowTarget) return workflowTarget;
  const target = resolveRoutineMountedAppTarget(state, routine);
  return target ? { workspaceRoot: target.workspaceRoot } : undefined;
}

function resolveRoutineWorkflowTarget(state: BridgeState, routine: Routine): FlowObserverTarget | undefined {
  const document = resolveRoutineWorkflowDocument(state, routine);
  if (!document) return undefined;
  const appId = stringMetadata(document.metadata?.workflowAppId);
  if (!appId) return undefined;
  const target = resolveMountedAppTarget(state, appId);
  if (!target) return undefined;
  return {
    workspaceRoot: target.workspaceRoot,
    initiator: workflowKnowledgeInitiator(document.id),
  };
}

function resolveRoutineWorkflowDocument(state: BridgeState, routine: Routine): KnowledgeDocument | undefined {
  const sourceKnowledgeId = stringMetadata(routine.sourceKnowledgeId);
  if (!sourceKnowledgeId) return undefined;
  const document = state.app.knowledge.get(sourceKnowledgeId);
  return document?.type === "routine" && stringMetadata(document.metadata?.workflowAppId) ? document : undefined;
}

function resolveRoutineMountedAppTarget(state: BridgeState, routine: Routine): MountedAppTarget | undefined {
  const targetByKey = mountedAppTargetsByKey(state);
  const candidates = new Map<string, MountedAppTarget>();
  for (const key of routineAppScopeKeys(state, routine)) {
    const target = targetByKey.get(key);
    if (target) candidates.set(target.id, target);
  }
  return candidates.size === 1 ? Array.from(candidates.values())[0] : undefined;
}

function mountedAppTargetsByKey(state: BridgeState): Map<string, MountedAppTarget> {
  const map = new Map<string, MountedAppTarget>();
  for (const mountedApp of state.settings.mountedApps ?? []) {
    if (mountedApp.enabled === false) continue;
    const lookupKeys = [mountedApp.id, appScopedRoomComponent(mountedApp.id)];
    for (const key of lookupKeys) {
      const target = resolveMountedAppTarget(state, key);
      if (!target) continue;
      map.set(target.id, target);
      map.set(appScopedRoomComponent(target.id), target);
      if (mountedApp.id) {
        map.set(mountedApp.id, target);
        map.set(appScopedRoomComponent(mountedApp.id), target);
      }
    }
  }
  return map;
}

function routineAppScopeKeys(state: BridgeState, routine: Routine): Set<string> {
  const keys = new Set<string>();
  const members = new Map(state.app.rooms.listMembers().map((member) => [member.id, member]));
  const rooms = new Map(state.app.rooms.listRooms().map((room) => [room.id, room]));
  for (const step of routine.steps) {
    if (step.memberId) {
      const appId = members.get(step.memberId)?.appId;
      if (appId) keys.add(appId);
    }
    addRoomScopeKeys(keys, rooms, step.roomId);
    addRoomScopeKeys(keys, rooms, inputRoomId(step.input));
  }
  return keys;
}

function addRoomScopeKeys(
  keys: Set<string>,
  rooms: ReadonlyMap<string, { scope?: { kind: "app"; appId: string } }>,
  roomId: string | undefined,
): void {
  if (!roomId) return;
  const scope = rooms.get(roomId)?.scope;
  if (scope?.kind === "app") keys.add(scope.appId);
}

function inputRoomId(value: JsonValue | undefined): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const roomId = (value as Record<string, unknown>).roomId;
  return typeof roomId === "string" && roomId.trim() ? roomId.trim() : undefined;
}
