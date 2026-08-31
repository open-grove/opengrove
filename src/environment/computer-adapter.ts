import type { AgentComputerContext, JsonObject } from "../core.js";
import {
  isoTimestamp,
  nonEmptyStrings,
  type EnvironmentActionRequest,
  type EnvironmentActionResult,
  type EnvironmentAdapter,
  type EnvironmentObservation,
} from "./adapter.js";

export type ComputerStateSnapshot = AgentComputerContext;
export type ComputerStateReader = () => ComputerStateSnapshot | Promise<ComputerStateSnapshot>;

export interface ComputerEnvironmentObservation extends EnvironmentObservation {
  kind: "computer";
  data: JsonObject;
}

export interface ComputerEnvironmentAdapter extends EnvironmentAdapter<ComputerEnvironmentObservation> {
  kind: "computer";
}

export function createStagedComputerAdapter(readComputer: ComputerStateReader): ComputerEnvironmentAdapter {
  return {
    kind: "computer",
    async observe() {
      return computerSnapshotToObservation(await readComputer());
    },
    async requestAction(request: EnvironmentActionRequest) {
      const currentSnapshot = normalizeComputerSnapshot(await readComputer());
      const guard = readComputerActionGuard(request);
      if (hasSnapshotDrift(guard, currentSnapshot)) {
        const blockedData: JsonObject = {
          action: request.action,
          target: request.target ?? "",
          elementId: request.elementId ?? "",
          currentApp: currentSnapshot.app ?? "",
          currentWindowTitle: currentSnapshot.windowTitle ?? "",
          currentUrl: currentSnapshot.url ?? "",
          currentObservedAt: currentSnapshot.observedAt ?? "",
          expectedApp: guard.app ?? "",
          expectedWindowTitle: guard.windowTitle ?? "",
          expectedUrl: guard.url ?? "",
          expectedObservedAt: guard.observedAt ?? "",
          needsReobserve: true,
        };
        return {
          status: "blocked",
          message: "Computer state changed since this action was proposed. Re-observe before executing it.",
          data: blockedData,
        };
      }

      const stagedData: JsonObject = {
        action: request.action,
        target: request.target ?? "",
        elementId: request.elementId ?? "",
        x: request.x ?? "",
        y: request.y ?? "",
        text: request.text ?? "",
        key: request.key ?? "",
        direction: request.direction ?? "",
        rationale: request.rationale ?? "",
        ...sanitizeJsonRecord(request.data),
        nextStep: "Re-observe the UI after this action before planning another step.",
        nextIntegrationPoint: "system-level Computer Use adapter",
      };
      return {
        status: "staged",
        message: "This V0 computer adapter records computer actions but does not execute them yet.",
        data: stagedData,
      };
    },
    canExecute() {
      return false;
    },
  };
}

export function computerSnapshotToObservation(value: ComputerStateSnapshot): ComputerEnvironmentObservation {
  const snapshot = normalizeComputerSnapshot(value);
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];

  return {
    kind: "computer",
    observedAt: isoTimestamp(snapshot.observedAt),
    summary: [snapshot.app, snapshot.windowTitle].filter(Boolean).join(" · ") || snapshot.url || "computer snapshot",
    sourceArtifactIds: nonEmptyStrings([snapshot.screenshotArtifactId]),
    data: {
      app: snapshot.app ?? "",
      windowTitle: snapshot.windowTitle ?? "",
      url: snapshot.url ?? "",
      focusedElement: snapshot.focusedElement ?? "",
      observation: snapshot.observation ?? "",
      screenshotArtifactId: snapshot.screenshotArtifactId ?? "",
      observedAt: isoTimestamp(snapshot.observedAt),
      elementCount: elements.length,
      elements: elements.slice(0, 12).map((item) => ({
        id: item.id ?? "",
        role: item.role ?? "",
        name: item.name ?? "",
        value: item.value ?? "",
        description: item.description ?? "",
      })),
      accessibilityTree: truncate(snapshot.accessibilityTree ?? "", 2400),
      actionStyle: "Prefer element-scoped actions and re-observe after each UI change.",
    },
  };
}

export function buildComputerActionRequest(action: string, input: JsonObject): EnvironmentActionRequest {
  const request: EnvironmentActionRequest = {
    kind: "computer",
    action,
    target: readString(input, "target"),
    elementId: readString(input, "elementId"),
    rationale: readString(input, "rationale"),
    data: {
      app: readString(input, "app"),
      windowTitle: readString(input, "windowTitle"),
      url: readString(input, "url"),
      focusedElement: readString(input, "focusedElement"),
      screenshotArtifactId: readString(input, "screenshotArtifactId"),
      observedAt: readString(input, "observedAt"),
    },
  };

  const x = readNumber(input, "x");
  const y = readNumber(input, "y");
  if (typeof x === "number") request.x = x;
  if (typeof y === "number") request.y = y;

  switch (action) {
    case "set_value":
    case "type_text":
      request.text = readRequiredString(input, "text");
      break;
    case "press_key":
      request.key = readRequiredString(input, "key");
      break;
    case "scroll":
      request.direction = readRequiredString(input, "direction");
      break;
    default:
      break;
  }

  return request;
}

export function normalizeComputerSnapshot(
  value: Record<string, unknown> | ComputerStateSnapshot,
): ComputerStateSnapshot {
  const record = jsonRecord(value);
  return {
    app: stringValue(record.app),
    windowTitle: stringValue(record.windowTitle),
    url: stringValue(record.url),
    focusedElement: stringValue(record.focusedElement),
    observation: stringValue(record.observation),
    accessibilityTree: stringValue(record.accessibilityTree),
    screenshotArtifactId: stringValue(record.screenshotArtifactId),
    observedAt: stringValue(record.observedAt),
    elements: normalizeComputerElements(record.elements),
  };
}

export function hasComputerState(snapshot: ComputerStateSnapshot): boolean {
  return Boolean(
    snapshot.app ||
      snapshot.windowTitle ||
      snapshot.url ||
      snapshot.focusedElement ||
      snapshot.observation ||
      snapshot.accessibilityTree ||
      snapshot.screenshotArtifactId ||
      (Array.isArray(snapshot.elements) && snapshot.elements.length > 0),
  );
}

export function normalizeComputerElements(value: unknown): ComputerStateSnapshot["elements"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => jsonRecord(item))
    .map((item) => ({
      id: stringValue(item.id),
      role: stringValue(item.role),
      name: stringValue(item.name),
      value: stringValue(item.value),
      description: stringValue(item.description),
    }))
    .filter((item) => item.id || item.role || item.name || item.value || item.description);
}

export function actionResultToToolFailure(result: EnvironmentActionResult): string {
  return result.status === "blocked" ? "environment_blocked" : "environment_failed";
}

function readComputerActionGuard(request: EnvironmentActionRequest): {
  app: string;
  windowTitle: string;
  url: string;
  observedAt: string;
} {
  const data = jsonRecord(request.data);
  return {
    app: stringValue(data.app),
    windowTitle: stringValue(data.windowTitle),
    url: stringValue(data.url),
    observedAt: stringValue(data.observedAt),
  };
}

function hasSnapshotDrift(
  guard: {
    app: string;
    windowTitle: string;
    url: string;
    observedAt: string;
  },
  snapshot: ComputerStateSnapshot,
): boolean {
  if (guard.observedAt && snapshot.observedAt && guard.observedAt !== snapshot.observedAt) {
    return true;
  }

  return (
    matchesChanged(guard.app, snapshot.app) ||
    matchesChanged(guard.windowTitle, snapshot.windowTitle) ||
    matchesChanged(guard.url, snapshot.url)
  );
}

function matchesChanged(expected: string, current?: string): boolean {
  return Boolean(expected && current && expected !== current);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sanitizeJsonRecord(value: unknown): JsonObject {
  const record = jsonRecord(value);
  const entries = Object.entries(record).filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries) as JsonObject;
}

function readRequiredString(input: JsonObject, key: string): string {
  const value = readString(input, key);
  if (!value) {
    throw new Error(`Expected non-empty string input: ${key}`);
  }
  return value;
}

function readString(input: JsonObject, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
