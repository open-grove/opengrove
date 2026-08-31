import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createDiagnosticBundle,
  defaultDiagnosticBundleFileName,
  type DiagnosticBundleVersions,
} from "../src/diagnostics/diagnostic-bundle.js";
import { inspectStoreAppLayoutV2Diagnostics } from "../src/server/migrations/store-app-layout-v2-diagnostics.js";
import type { DesktopBridgeDiagnostics } from "./bridge-supervisor.js";

export type DesktopDiagnosticBundleVersions = DiagnosticBundleVersions;

export interface DesktopDiagnosticBundleResult {
  status: "saved";
  path: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  evidenceComplete: boolean;
}

export async function exportDesktopDiagnosticBundle(options: {
  outputPath: string;
  diagnostics: DesktopBridgeDiagnostics;
  versions: DesktopDiagnosticBundleVersions;
  isPackaged: boolean;
  runDiagnostics?: unknown;
  secrets?: string[];
}): Promise<DesktopDiagnosticBundleResult> {
  const bundle = await createDiagnosticBundle({
    diagnosticsDir: options.diagnostics.paths.diagnosticsDir,
    logDirs: [options.diagnostics.paths.logDir],
    bridgeStatus: options.diagnostics,
    versions: options.versions,
    isPackaged: options.isPackaged,
    runDiagnostics: options.runDiagnostics,
    storeAppLayout: inspectStoreAppLayoutV2Diagnostics({
      roots: {
        programsRoot: options.diagnostics.paths.programsDir,
        workspacesRoot: options.diagnostics.paths.workspacesDir,
        legacyProgramsRoot: join(options.diagnostics.paths.dataDir, "app-store", "programs"),
        legacyWorkspacesRoot: join(options.diagnostics.paths.userDataDir, "apps"),
      },
    }),
    secrets: options.secrets,
  });
  await writeFile(options.outputPath, bundle.archive);
  return {
    status: "saved",
    path: options.outputPath,
    fileName: basename(options.outputPath),
    sizeBytes: bundle.sizeBytes,
    sha256: bundle.sha256,
    evidenceComplete: bundle.evidenceComplete,
  };
}

export { defaultDiagnosticBundleFileName };
