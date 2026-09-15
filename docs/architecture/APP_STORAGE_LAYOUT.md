# Store App storage layout

OpenGrove treats an installed Store App as two resources with different
lifecycles:

- **Program**: downloaded, versioned, reproducible, and replaceable.
- **Workspace**: user-owned, stable, and never part of a program replacement.

They are logical peers, not children that must share one physical parent. This
matches the storage boundaries used by mature desktop and agent products:

| Reference | Replaceable program/tool data | Durable user/project data |
| --- | --- | --- |
| [VS Code](https://github.com/microsoft/vscode) | versioned extension directories under the extensions root | user data and opened workspaces remain outside extension versions |
| [GitHub Desktop](https://github.com/desktop/desktop) | application/runtime data is managed by the desktop app | repositories stay at user-selected filesystem paths |
| [pi](https://github.com/badlogic/pi-mono) | global agent packages/configuration under `~/.pi/agent` | project-local state can live under the project `.pi` boundary |
| [OpenCode](https://github.com/anomalyco/opencode) | desktop CLI versions and XDG cache/data are replaceable | projects remain at their own paths; config/state use separate XDG roots |
| [LobeHub](https://github.com/lobehub/lobehub) | managed tools use versioned `bin/<tool>/<version>`-style roots | application data is held separately from managed binaries |

OpenGrove therefore uses this logical layout:

```text
programs/<app-id>/<version>-<archive>-<generation>/app
workspaces/<app-id>/workspace
state/                 # existing Host state and atomic mount pointer
cache/                 # disposable Host caches
```

`<app-id>` stays human-readable. Characters or complete names that Windows
cannot use as directory components are percent-escaped consistently in both
roots; the manifest and mounted setting remain the authoritative App identity.

The physical defaults are platform-native:

| Resource | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Programs | `~/Library/Application Support/OpenGrove/programs` | `%LOCALAPPDATA%\OpenGrove\programs` | `$XDG_DATA_HOME/opengrove/programs` (or `~/.local/share/opengrove/programs`) |
| Workspaces | `~/OpenGrove/workspaces` | `%USERPROFILE%\OpenGrove\workspaces` | `~/OpenGrove/workspaces` |
| State/settings | `~/Library/Application Support/OpenGrove/data` | `%APPDATA%\OpenGrove\data` | `$XDG_CONFIG_HOME/opengrove/data` |

Development profiles keep equivalent `programs` and `workspaces` directories
inside their isolated profile root so they cannot modify a packaged install.

## Legacy migration transaction

The one-time migration from `<userData>/apps` and
`<userData>/data/app-store/programs` deliberately does not rename a live source
directory:

1. Attribute the old program, package marker, manifest, Workspace binding, and
   roots to the same Store App. Unknown or manual mounts are skipped.
2. Copy the Workspace into a uniquely named sibling `.migrating-*` directory,
   hash every file and compare the complete tree, then rename the sibling to its
   final name.
3. Copy the immutable program without following its Workspace link, compare the
   complete program tree, bind it to the new Workspace, then rename that sibling
   generation to its final name.
4. Recreate the Bridge App with the new in-memory paths, then compare the
   complete source and target Workspace trees again, while the persisted
   `bridge-settings.json` pointer and every legacy path remain unchanged.
5. Only after that health boundary succeeds, atomically replace
   `bridge-settings.json`, then rename the old directories to adjacent
   `.legacy-v2` names. No second pointer database is introduced. Legacy paths
   are retained, not deleted; a Windows sharing violation only defers this
   final rename.

Any inspection, copy, validation, candidate recreation, persistence, or rename
failure before step 5 leaves the old persisted settings and old paths
authoritative. If the recreated candidate App is not healthy, startup restores
the old in-memory paths and recreates the legacy App.
Legacy retirement and cleanup failures are logged and retried but never abort
Bridge startup. A later startup can reuse final copies only when their content
validates exactly against the source. Absolute symlinks and relative symlinks
that leave the migrated tree are deferred because retaining them would make the
later legacy-directory rename break user data.

## Upgrade backup management

Storage settings include retained ".legacy-v2" App directories in **Update
backups**, alongside state migration backups. These directories do not count as
live works or disposable runtime files. Safe cache cleanup and later retirement
passes leave them in place; no release number or elapsed time triggers deletion.

After a newly migrated App passes the complete copy validation, App recreation,
and persisted pointer switch, OpenGrove records the completed activation beside
the retained data. Before offering deletion, it checks the current settings,
persisted settings, and bindings used by the successfully recreated App. The
program's Workspace link must resolve to the expected existing Workspace; the
recorded Workspace and backup directory identities must still match. Mounted
paths and links are checked for references to the old directories.

Older backups without a receipt are checked for ownership, the active new
Workspace binding, and references to the retired location. Successful checks
record current activation evidence, distinguished from migration-time copy
validation. Deleting a backup does not compare old and current Workspace contents:
normal additions, edits, and intentional deletions must not prevent removing an
older version. Full content validation belongs to the migration transaction,
before switching the authoritative pointer.

App file operations resolve the currently mounted Workspace. After a successful
switch, the old Workspace is a retained snapshot, not the App's file-operation
root. It still exists on disk and may be referenced manually, so reference checks
remain necessary. Unavailable Workspaces, unconfirmed activation, unknown backup
ownership, and invalid records never authorize deletion.

Deletion first prepares a ten-minute confirmation containing the exact eligible
backup set and size, protected items, and current Workspace locations. The user
must confirm that the affected Apps work normally in their new Workspaces and
that the older versions are no longer needed. The server then
rechecks that set, directory identities, file metadata, activation evidence, and
references under a Run maintenance lease. Changed backup contents, changed
Workspace bindings, or an expired confirmation require another preview. Normal edits to the current Workspace do not invalidate
the confirmation. The confirmation is single-use and accepts no client
filesystem paths. Recursive removal does not follow symbolic links; incomplete
removal is reported, with remaining contents retained at their original location.

This backup compatibility reader remains supported while layout-v2 retained
backups need management, independently of the retirement of older migration
source formats.

## Compatibility and diagnostics boundary

Layout v2 is introduced in OpenGrove 0.6.6 and accepts legacy layouts written
by OpenGrove 0.6.5 or earlier. This includes the 0.6.4 direct installation at
`apps/<app-id>`, the 0.6.5 side-by-side program layout, and machines where both
remain at the same time. The migration and all legacy-root recognition live
under `src/server/migrations/store-app-layout-v2*`. They can be removed when
every supported direct upgrade source already uses layout v2 (OpenGrove 0.6.6
or newer).

Both the normal Bridge export and the desktop startup-failure export include
`store-app-layout.json`. It records the layout and migration version, resolved
current and legacy roots, whether the roots are separated, each mounted App's
current/legacy/outside classification, filesystem accessibility, bounded
`.migrating-*` and `.legacy-v2` remnants, and inspection failures. Migration
event names are included as an index into the bundled Bridge log. The inspector
does not hash, read, or export Workspace file contents.
