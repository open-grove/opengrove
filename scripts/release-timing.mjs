import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openReleaseTiming({
  path,
  command,
  product = "OpenGrove",
  version,
  reset = false,
  configuration = {},
}) {
  const timingPath = resolve(path);
  let sequence = 0;

  if (reset || !existsSync(timingPath)) {
    const startedAt = new Date().toISOString();
    writeReport({
      schemaVersion: 1,
      product,
      version,
      command,
      status: "running",
      startedAt,
      completedAt: null,
      durationMs: null,
      updatedAt: startedAt,
      configuration: { ...configuration },
      phases: [],
      files: [],
    });
  } else if (Object.keys(configuration).length > 0) {
    update((report) => {
      report.configuration = { ...report.configuration, ...configuration };
    });
  }

  return {
    path: timingPath,
    setConfiguration(values) {
      update((report) => {
        report.configuration = { ...report.configuration, ...values };
      });
    },
    startPhase(name, details = {}) {
      const id = nextId("phase");
      update((report) => {
        report.phases.push({
          id,
          name,
          status: "running",
          startedAt: new Date().toISOString(),
          completedAt: null,
          durationMs: null,
          ...details,
        });
      });
      return id;
    },
    finishPhase(id, { status = "success", error, ...details } = {}) {
      update((report) => {
        const phase = requiredEntry(report.phases, id, "phase");
        const completedAt = new Date().toISOString();
        Object.assign(phase, details, {
          status,
          completedAt,
          durationMs: elapsedMilliseconds(phase.startedAt, completedAt),
          ...(error ? { error: errorMessage(error) } : {}),
        });
      });
    },
    startFile(stage, details) {
      const id = nextId("file");
      update((report) => {
        report.files.push({
          id,
          stage,
          status: "running",
          startedAt: new Date().toISOString(),
          completedAt: null,
          durationMs: null,
          bytesProcessed: 0,
          intervalBytesPerSecond: 0,
          averageBytesPerSecond: 0,
          ...details,
        });
      });
      return id;
    },
    updateFile(id, details) {
      update((report) => {
        Object.assign(requiredEntry(report.files, id, "file"), details);
      });
    },
    finishFile(id, { status = "success", error, ...details } = {}) {
      update((report) => {
        const file = requiredEntry(report.files, id, "file");
        const completedAt = new Date().toISOString();
        Object.assign(file, details, {
          status,
          completedAt,
          durationMs: elapsedMilliseconds(file.startedAt, completedAt),
          ...(error ? { error: errorMessage(error) } : {}),
        });
      });
    },
    finishRun({ status = "success", error } = {}) {
      update((report) => {
        const completedAt = new Date().toISOString();
        report.status = status;
        report.completedAt = completedAt;
        report.durationMs = elapsedMilliseconds(report.startedAt, completedAt);
        if (error) report.error = errorMessage(error);
      });
    },
    read() {
      return readReport();
    },
  };

  function nextId(kind) {
    sequence += 1;
    return `${kind}-${Date.now()}-${process.pid}-${sequence}`;
  }

  function update(mutator) {
    const report = readReport();
    mutator(report);
    report.updatedAt = new Date().toISOString();
    writeReport(report);
  }

  function readReport() {
    return JSON.parse(readFileSync(timingPath, "utf8"));
  }

  function writeReport(report) {
    mkdirSync(dirname(timingPath), { recursive: true });
    const temporaryPath = `${timingPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(temporaryPath, timingPath);
  }
}

export function runTimedPhase(timing, name, action) {
  const phaseId = timing.startPhase(name);
  try {
    const result = action();
    timing.finishPhase(phaseId);
    return result;
  } catch (error) {
    timing.finishPhase(phaseId, { status: "failed", error });
    throw error;
  }
}

export function formatReleaseBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function requiredEntry(entries, id, kind) {
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw new Error(`release timing ${kind} not found: ${id}`);
  return entry;
}

function elapsedMilliseconds(startedAt, completedAt) {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
