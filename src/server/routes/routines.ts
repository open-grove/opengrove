import type { JsonValue, Routine, RoutineStep } from "../../core.js";
import { createRoutineDraftFromEvents, runRoutine } from "../../routines/routine-runner.js";
import { createRoutineFlowInstanceObserver } from "../routine-flow-instance.js";
import { importRoutineFromKnowledgeOrContent } from "../routine-import.js";
import { createRoutineMemberExecutor } from "../routine-scheduler.js";
import { createRoutineProblemReporter } from "../routine-problems.js";
import { record, stringValue } from "../http-utils.js";
import { normalizeRoutineDraftPayload } from "../payloads.js";
import type { BridgeRoute, BridgeRouteContext } from "../router.js";
import { readWwRuntimeAuth } from "../bridge-security.js";
import { runWithBridgeTurnContext } from "../bridge-turn-context.js";
import { route } from "./registry-utils.js";

export function createRoutineRoutes(): BridgeRoute[] {
  return [
    route("routines-list", "GET", "/routines", handleRoutinesListRoute),
    route("routine-create", "POST", "/routines", handleRoutineCreateRoute),
    route("routine-draft", "POST", "/routines/draft", handleRoutineDraftRoute),
    route("routine-import", "POST", "/routines/import", handleRoutineImportRoute),
    route("routine-schedule", "POST", /^\/routines\/([^/]+)\/schedule$/, handleRoutineScheduleRoute),
    route("routine-run", "POST", /^\/routines\/([^/]+)\/run$/, handleRoutineRunRoute),
  ];
}

function handleRoutinesListRoute(context: BridgeRouteContext): boolean {
  const status = context.url.searchParams.get("status");
  const routines = (
    status === "draft" ||
    status === "active" ||
    status === "paused" ||
    status === "needs_repair" ||
    status === "archived"
      ? context.state.app.routines.list(status)
      : context.state.app.routines.list()
  )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, readRoutineLimit(context.url));
  context.sendJson(context.response, 200, { ok: true, routines });
  return true;
}

function readRoutineLimit(url: URL): number {
  const requested = Number(url.searchParams.get("limit") ?? 100);
  return Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 500) : 100;
}

async function handleRoutineCreateRoute(context: BridgeRouteContext): Promise<boolean> {
  const body = record(await context.readJsonBody(context.request));
  const title = stringValue(body.title);
  if (!title) {
    context.sendJson(context.response, 400, { ok: false, error: "title_required" });
    return true;
  }
  const trigger = stringValue(body.trigger);
  if (trigger && trigger !== "manual" && trigger !== "schedule" && trigger !== "event") {
    context.sendJson(context.response, 400, { ok: false, error: "trigger_invalid" });
    return true;
  }
  const schedule = normalizeRoutineSchedule(body.schedule);
  if (trigger === "schedule" && !schedule) {
    context.sendJson(context.response, 400, { ok: false, error: "schedule_required" });
    return true;
  }
  const steps = normalizeRoutineSteps(body.steps);
  if (steps.length === 0) {
    context.sendJson(context.response, 400, { ok: false, error: "steps_required" });
    return true;
  }
  const routine = context.state.app.routines.create({
    title,
    description: stringValue(body.description) || undefined,
    status: body.status === "draft" ? "draft" : "active",
    trigger: (trigger || "manual") as Routine["trigger"],
    ...(schedule ? { schedule } : {}),
    capabilityIds: [],
    approvalRules: [],
    steps,
  });
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, { ok: true, routine });
  return true;
}

function normalizeRoutineSchedule(value: unknown): Routine["schedule"] {
  const object = record(value);
  const rawEveryMinutes = object.everyMinutes;
  const everyMinutes =
    typeof rawEveryMinutes === "number"
      ? rawEveryMinutes
      : typeof rawEveryMinutes === "string" && rawEveryMinutes.trim()
        ? Number(rawEveryMinutes)
        : undefined;
  const at = stringValue(object.at);
  if (everyMinutes !== undefined) {
    if (at) return undefined;
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 24 * 60) return undefined;
    const daysOfWeek = Array.isArray(object.daysOfWeek)
      ? object.daysOfWeek.filter((day): day is number => typeof day === "number" && day >= 0 && day <= 6)
      : undefined;
    return { everyMinutes, ...(daysOfWeek?.length ? { daysOfWeek } : {}) };
  }
  const match = at.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  const daysOfWeek = Array.isArray(object.daysOfWeek)
    ? object.daysOfWeek.filter((day): day is number => typeof day === "number" && day >= 0 && day <= 6)
    : undefined;
  return { at, ...(daysOfWeek?.length ? { daysOfWeek } : {}) };
}

function normalizeRoutineSteps(value: unknown): RoutineStep[] {
  if (!Array.isArray(value)) return [];
  const steps: RoutineStep[] = [];
  for (const [index, entry] of value.entries()) {
    const object = record(entry);
    const memberId = stringValue(object.memberId);
    const toolId = stringValue(object.toolId);
    if (!memberId && !toolId) continue;
    steps.push({
      id: stringValue(object.id) || `step_${index + 1}`,
      title: stringValue(object.title) || stringValue(object.prompt).slice(0, 60) || `Step ${index + 1}`,
      ...(toolId ? { toolId } : {}),
      ...(memberId ? { memberId } : {}),
      ...(stringValue(object.roomId) ? { roomId: stringValue(object.roomId) } : {}),
      ...(stringValue(object.prompt) ? { prompt: stringValue(object.prompt) } : {}),
      ...(object.input !== undefined ? { input: object.input as RoutineStep["input"] } : {}),
      ...(normalizeRoutineStepCondition(object.when) ? { when: normalizeRoutineStepCondition(object.when) } : {}),
    });
  }
  return steps;
}

function normalizeRoutineStepCondition(value: unknown): RoutineStep["when"] | undefined {
  const object = record(value);
  const stepId = stringValue(object.stepId);
  if (!stepId) return undefined;
  const operatorValue = stringValue(object.operator);
  const operator =
    operatorValue === "truthy" ||
    operatorValue === "equals" ||
    operatorValue === "notEquals" ||
    operatorValue === "gt" ||
    operatorValue === "gte" ||
    operatorValue === "lt" ||
    operatorValue === "lte"
      ? operatorValue
      : undefined;
  return {
    stepId,
    ...(stringValue(object.path) ? { path: stringValue(object.path) } : {}),
    ...(operator ? { operator } : {}),
    ...(object.value !== undefined ? { value: object.value as JsonValue } : {}),
  };
}

async function handleRoutineDraftRoute(context: BridgeRouteContext): Promise<boolean> {
  const payload = normalizeRoutineDraftPayload(await context.readJsonBody(context.request));
  const routine = createRoutineDraftFromEvents(context.state.app, payload);
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, { ok: true, routine });
  return true;
}

async function handleRoutineScheduleRoute(context: BridgeRouteContext): Promise<boolean> {
  const match = context.url.pathname.match(/^\/routines\/([^/]+)\/schedule$/);
  if (!match) return false;
  const routineId = decodeURIComponent(match[1] || "");
  const existing = context.state.app.routines.get(routineId);
  if (!existing) {
    context.sendJson(context.response, 404, { ok: false, error: "routine_not_found" });
    return true;
  }

  const body = record(await context.readJsonBody(context.request));
  const trigger = stringValue(body.trigger) || (body.enabled === false ? "manual" : "schedule");
  if (trigger !== "manual" && trigger !== "schedule") {
    context.sendJson(context.response, 400, { ok: false, error: "trigger_invalid" });
    return true;
  }
  if (trigger === "manual") {
    const routine = context.state.app.routines.update(routineId, {
      trigger: "manual",
      schedule: undefined,
    });
    context.state.store.saveFrom(context.state.app);
    context.sendJson(context.response, 200, { ok: true, routine });
    return true;
  }

  const schedule = normalizeRoutineSchedule(body.schedule);
  if (!schedule) {
    context.sendJson(context.response, 400, { ok: false, error: "schedule_required" });
    return true;
  }
  const routine = context.state.app.routines.update(routineId, {
    trigger: "schedule",
    schedule,
  });
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, { ok: true, routine });
  return true;
}

async function handleRoutineRunRoute(context: BridgeRouteContext): Promise<boolean> {
  const routineRunAction = context.url.pathname.match(/^\/routines\/([^/]+)\/run$/);
  if (!routineRunAction) return false;
  const [, routineId] = routineRunAction;
  const decodedRoutineId = decodeURIComponent(routineId!);
  const wwAuth = (await readWwRuntimeAuth(context.request, context.response, context.security))?.auth;
  const result = await runWithBridgeTurnContext(
    {
      threadId: `routine:${decodedRoutineId}`,
      model: context.state.model,
      snapshot: { title: "Routine", visibleText: decodedRoutineId },
      computerSnapshot: {},
      policyOverrides: [],
      ...(wwAuth ? { wwAuth } : {}),
    },
    () =>
      runRoutine(context.state.app, decodedRoutineId, {
        memberExecutor: createRoutineMemberExecutor(context.state),
        problemReporter: createRoutineProblemReporter(context.state, context.traceId),
        statusObserver: createRoutineFlowInstanceObserver(context.state),
      }),
  );
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, { ok: true, ...result });
  return true;
}

// 导入 .routine.md 文件 → 解析 → 逐 step 导入期校验 → routines.create。
// 路径边界:不接受任意 filePath,只接受 { knowledgeId }(按真实 vault 路径校验)或 { content }(内联)。
async function handleRoutineImportRoute(context: BridgeRouteContext): Promise<boolean> {
  const body = record(await context.readJsonBody(context.request));
  const knowledgeId = stringValue(body.knowledgeId);
  const content = knowledgeId ? undefined : stringValue(body.content);
  const imported = importRoutineFromKnowledgeOrContent(context.state.app, {
    ...(knowledgeId ? { knowledgeId } : {}),
    ...(content ? { content } : {}),
  });
  if (!imported.ok) {
    context.sendJson(context.response, imported.status, {
      ok: false,
      error: imported.error,
      ...(imported.vaultPath ? { vaultPath: imported.vaultPath } : {}),
    });
    return true;
  }
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, { ok: true, routine: imported.routine });
  return true;
}
