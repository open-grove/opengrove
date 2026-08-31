import type { OpenGroveApp } from "../app/create-opengrove.js";
import type { ArtifactRecord } from "../core.js";
import { computerSnapshotToObservation } from "../environment/computer-adapter.js";
import type { ComputerStateSnapshot } from "../environment/computer-adapter.js";
import { hostMessage } from "../localization/host-messages.js";
import type { SupportedLocale } from "../localization/locale-registry.js";
import { dedupeIds } from "./http-utils.js";

export function createAnnotationArtifact(
  app: OpenGroveApp,
  parentArtifactId: string,
  input: { text: string; title?: string; tags?: string[] },
  language: SupportedLocale = "en",
): ArtifactRecord {
  const parent = app.artifacts.get(parentArtifactId);
  if (!parent) {
    throw new Error(`artifact_not_found:${parentArtifactId}`);
  }

  const sessionId = app.workingState.get().sessionId ?? "browser-bridge";
  const runId = `annotation_${Date.now()}`;

  app.recordEvent(
    { type: "turn.started", runId, at: new Date().toISOString() },
    {
      sessionId,
      activity: "local",
      input: input.text,
    },
  );
  app.recordEvent(
    {
      type: "tool.started",
      runId,
      toolId: "artifact.annotation",
      input: { parentArtifactId, text: input.text },
    },
    {
      sessionId,
      activity: "local",
      input: input.text,
    },
  );
  const lineage = dedupeIds([...(parent.lineage ?? []), parent.id]);
  const artifact = app.artifacts.create({
    type: "annotation",
    title:
      input.title ||
      hostMessage(language, "artifact.annotation_title", {
        parent: parent.title || parent.id,
      }),
    tags: dedupeIds(["annotation", ...(input.tags ?? []), ...parent.tags]),
    parentId: parent.id,
    derivedFrom: dedupeIds([parent.id, ...(parent.derivedFrom ?? [])]),
    lineage,
    sourceRefs: parent.sourceRefs,
    provenance: {
      parentType: parent.type,
      createdBy: "local-bridge.annotation",
    },
    data: {
      text: input.text,
      parentArtifactId: parent.id,
      parentTitle: parent.title ?? "",
    },
  });

  app.recordEvent(
    {
      type: "tool.finished",
      runId,
      toolId: "artifact.annotation",
      result: { ok: true, value: { artifactId: artifact.id, parentArtifactId: parent.id } },
    },
    {
      sessionId,
      activity: "local",
      input: input.text,
    },
  );
  app.recordEvent(
    { type: "turn.finished", runId, at: new Date().toISOString() },
    {
      sessionId,
      activity: "local",
      input: input.text,
    },
  );
  app.workingState.update({
    pinnedArtifactIds: dedupeIds([...app.workingState.get().pinnedArtifactIds, parent.id, artifact.id]),
    workingArtifactIds: dedupeIds([...app.workingState.get().workingArtifactIds, artifact.id]),
  });
  return artifact;
}

export function createComputerSnapshotArtifact(app: OpenGroveApp, snapshot: ComputerStateSnapshot): ArtifactRecord {
  const observation = computerSnapshotToObservation(snapshot);
  const observedAt = observation.observedAt;
  const derivedFrom = dedupeIds(observation.sourceArtifactIds ?? []);
  const sessionId = app.workingState.get().sessionId ?? "browser-bridge";
  const runId = `computer_snapshot_${Date.now()}`;

  app.recordEvent(
    { type: "turn.started", runId, at: new Date().toISOString() },
    {
      sessionId,
      activity: "computer",
      input: observation.summary,
    },
  );
  app.recordEvent(
    {
      type: "tool.started",
      runId,
      toolId: "computer.snapshot",
      input: observation.data,
    },
    {
      sessionId,
      activity: "computer",
      input: observation.summary,
    },
  );
  const artifact = app.artifacts.create({
    type: "computer_snapshot",
    title: observation.summary,
    status: "observed",
    tags: dedupeIds(["computer", "snapshot", snapshot.app ?? ""]),
    derivedFrom: derivedFrom.length ? derivedFrom : undefined,
    lineage: derivedFrom.length ? derivedFrom : undefined,
    provenance: {
      createdBy: "local-bridge.computer-state",
      observedAt,
    },
    data: observation.data,
  });
  app.recordEvent(
    {
      type: "tool.finished",
      runId,
      toolId: "computer.snapshot",
      result: { ok: true, value: { artifactId: artifact.id } },
    },
    {
      sessionId,
      activity: "computer",
      input: observation.summary,
    },
  );
  app.recordEvent(
    { type: "turn.finished", runId, at: new Date().toISOString() },
    {
      sessionId,
      activity: "computer",
      input: observation.summary,
    },
  );

  const currentWorkingState = app.workingState.get();
  app.workingState.update({
    pinnedArtifactIds: dedupeIds([...currentWorkingState.pinnedArtifactIds, artifact.id]),
    workingArtifactIds: dedupeIds([...currentWorkingState.workingArtifactIds, artifact.id]),
  });
  return artifact;
}
