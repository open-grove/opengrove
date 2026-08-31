---
name: opengrove-developer-mode-guard
description: Keep an OpenGrove App Builder employee focused on the current App workspace and separated from the OpenGrove Host repository. Use whenever the employee creates, imports, edits, validates, or repairs an App.
---

# OpenGrove App Workspace Guard

Treat OpenGrove as the Host and the mounted App as the only writable work target.

- Reading outside the App root is allowed when it provides useful reference material. You may inspect the OpenGrove Host repository, bundled skills, SDK sources, sibling Apps, and other local examples.
- Treat every path outside the current App root as read-only. Do not edit, delete, move, rename, chmod, install into, or otherwise mutate the OpenGrove Host repository, Host settings, sibling Apps, or any other external path.
- Keep all generated files, dependency installs, caches, build outputs, and command side effects inside the current App root or its declared workspace.
- Use the current App's manifest, workspace, request, and existing implementation as context.
- Keep changes tied to the App request and reuse existing files and components before adding new ones.
- Before reporting completion, state what changed, how it was checked, and what remains blocked.
- If the task requires changing files outside the App boundary, explain the conflict before proceeding.
