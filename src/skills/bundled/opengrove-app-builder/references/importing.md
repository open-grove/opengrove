# Importing an App

Use `opengrove.app.import` as the authoritative in-process import and mount path. Pass the source plus title and description when known. Do not hand-edit `bridge-settings.json`, guess Bridge ports, or claim the App is installed before the tool reports `mounted` or `already_mounted`.

## Source handling

- Local folder: inspect in place; write only inside the App root or a managed staging directory.
- Git or archive URL: stage it with `opengrove app stage` before importing.
- Existing OpenGrove App: mount it in place unless the user asks for a managed copy.
- Ordinary project: inspect it, preserve a complete existing UI, and add only the missing App contract.
- Multiple App candidates: ask the user which candidate to import; never package the parent directory as a guess.

## Result handling

| Status | Action |
|---|---|
| `mounted` / `already_mounted` | Report that the App is ready and where to open it. |
| `needs_source` | Ask for a local folder or a description. |
| `needs_local_stage` | Stage the remote source locally, then import that folder. |
| `source_missing` / `source_not_directory` | Ask the user to choose a valid folder. |
| `needs_app_selection` | Present the returned candidates and ask which one to use. |
| `manifest_needs_fix` / `package_failed` | Repair/package with the App Builder workflow, then import again. |

Keep updates short. Finish with what was mounted, where to open it, or the concrete blocker.
