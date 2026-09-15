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
   roots to the same Store App. Unknown or manual mounts are skipped. Inspect
   both trees for link mappings, supported entry types, and generated Python
   environment paths before copying either tree.
2. Copy the Workspace into a uniquely named sibling `.migrating-*` directory,
   hash every file and compare the complete tree, then rename the sibling to its
   final name. Link targets and recognized environment paths are relocated
   in the staging copy and validated against the corresponding transformed source.
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
validates against the source with the same deterministic path transformations.
Conflicting existing copies are retained, not overwritten or merged.

### Link and environment relocation

Links are copied as links; migration does not copy, hash, or modify the contents
of external targets. External absolute links (such as a system Python interpreter)
retain their original target. Links into the migrating Program or Workspace map
to the final destination, including links between those two trees. Relative links
are recalculated from their final parent so they retain the intended destination.
Dangling links and cycles remain links and are never traversed recursively.
A link into another legacy App with no destination mapping is deferred during
preflight, before the large Workspace copy; its target might be retired later.
This follows the link-preservation approach in Cherry Studio's userDataRelocation,
adapted for OpenGrove's separately located Program and Workspace trees.

For a recognized Python virtual environment, migration updates `pyvenv.cfg` and
UTF-8 text launchers/activation scripts directly under `bin` or `Scripts` in the
copy. The `home` and `executable` configuration fields, the interpreter in
`command`, and direct Python shebangs or generated shell/Python launchers use
the same target mapping as links. This includes a base interpreter bundled
inside Program but outside the venv. External interpreter addresses stay intact;
unmapped legacy addresses fail preflight with `store_app_layout_unmapped_legacy_path`.
POSIX Python entry-point shebangs use a shell/Python launcher that supports
spaces and long paths. Paths refer to the final location, never staging. Installed
packages, binary files, other program text, and Workspace documents remain intact;
no Python or package installer is executed during migration. This is same-machine
repair of known generated paths, not general venv portability or binary-launcher
relocation. Targets with unsupported shell quoting are rejected before copying.
See [Python's venv guidance](https://docs.python.org/3.13/library/venv.html#how-venvs-work)
and [migration issue #102](https://github.com/open-grove/opengrove/issues/102).

Preflight does not replace complete copy validation or the final activation check.
Later copy, write, or rename errors can still retain an unused final Workspace
copy; it is reused only after validation and is not treated as a retired backup.

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
