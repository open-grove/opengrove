import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

export interface StateMigrationPaths {
  databasePath: string;
  legacyPath: string;
}

export function resolveStateMigrationPaths(requestedPath: string): StateMigrationPaths {
  const resolved = resolve(requestedPath);
  if (extname(resolved).toLowerCase() === ".json") {
    return {
      databasePath: join(dirname(resolved), `${basename(resolved, extname(resolved))}.sqlite`),
      legacyPath: resolved,
    };
  }
  return {
    databasePath: resolved,
    legacyPath: join(dirname(resolved), `${basename(resolved, extname(resolved))}.json`),
  };
}

/** Exact backup paths owned by the state migration subsystem. */
export function listStateMigrationBackupPaths(databasePath: string, legacyPath: string): string[] {
  const root = dirname(legacyPath);
  if (!existsSync(root)) return [];
  const entries = readdirSync(root);
  const databaseName = basename(databasePath);
  const legacyName = basename(legacyPath);
  const legacyExtension = extname(legacyPath) || ".json";
  const legacyStem = basename(legacyPath, extname(legacyPath));
  const sqliteMigrationPrefix = `${legacyStem}.before-sqlite-migration`;
  const legacyRecoveryPrefix = `${legacyStem}.before-legacy-recovery`;

  return entries
    .filter((entry) => {
      if (
        entry === `${sqliteMigrationPrefix}${legacyExtension}` ||
        (entry.startsWith(`${sqliteMigrationPrefix}-`) &&
          entry.endsWith(legacyExtension) &&
          /^\d+$/.test(entry.slice(sqliteMigrationPrefix.length + 1, -legacyExtension.length)))
      ) {
        return true;
      }
      if (
        entry === legacyRecoveryPrefix ||
        (entry.startsWith(`${legacyRecoveryPrefix}-`) && /^\d+$/.test(entry.slice(legacyRecoveryPrefix.length + 1)))
      ) {
        return true;
      }
      return (
        (entry.startsWith(`${databaseName}.before-`) || entry.startsWith(`${legacyName}.before-`)) &&
        entry.endsWith(".json") &&
        entry.slice(0, -".json".length).lastIndexOf(".before-") > 0
      );
    })
    .map((entry) => join(root, entry))
    .filter((path) => existsSync(path));
}
