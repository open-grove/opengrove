import type { JsonObject, SourceRef } from "../core.js";

export type EnvironmentKind = "browser" | "computer" | "local" | "api";

export interface EnvironmentObservation {
  kind: EnvironmentKind;
  observedAt: string;
  summary: string;
  sourceArtifactIds?: string[];
  data: JsonObject;
}

export interface EnvironmentActionRequest {
  kind: EnvironmentKind;
  action: string;
  target?: string;
  elementId?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: string;
  rationale?: string;
  data?: JsonObject;
}

export interface EnvironmentActionResult {
  status: "executed" | "staged" | "blocked" | "failed";
  observation?: EnvironmentObservation;
  artifactId?: string;
  message?: string;
  data?: JsonObject;
}

export interface EnvironmentAdapter<TObservation extends EnvironmentObservation = EnvironmentObservation> {
  kind: EnvironmentKind;
  observe(): Promise<TObservation>;
  requestAction(request: EnvironmentActionRequest): Promise<EnvironmentActionResult>;
  canExecute?(request: EnvironmentActionRequest): boolean;
}

export function observationSources(observation: EnvironmentObservation): SourceRef[] | undefined {
  if (!Array.isArray(observation.sourceArtifactIds) || observation.sourceArtifactIds.length === 0) {
    return undefined;
  }

  return observation.sourceArtifactIds.map((artifactId) => ({
    title: observation.summary || `${observation.kind} observation`,
    locator: `artifact:${artifactId}`,
  }));
}

export function isoTimestamp(value?: string): string {
  return value && value.trim() ? value.trim() : new Date().toISOString();
}

export function nonEmptyStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}
