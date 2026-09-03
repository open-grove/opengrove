export const EN_HOST_MESSAGES = {
  "agent.final_missing": "This run did not produce a displayable final reply. Check the run details.",
  "agent.run_failed": "This run failed. Check the run details.",
  "app.cli.check_failed": 'CLI "{cliId}" failed its readiness check: {detail}',
  "app.cli.missing_env": 'CLI "{cliId}" is missing environment variables: {env}',
  "app.cli.missing_env_and_check_failed":
    'CLI "{cliId}" is missing environment variables {env}, and its readiness check failed: {detail}',
  "app.cli.preflight_failed":
    "The CLI readiness check failed, so this command was not started.\n{failures}\nFix the CLI runtime or configure the missing environment variables, then try again.",
  "app.cli.missing_env_context":
    "App CLI environment notice (this does not block the run):\n{missing}\nThe Host did not inject these declared variables; this is not a CLI execution result. Continue normally. If the current task needs one of these CLIs, call it and handle the tool result.",
  "app.import.already_mounted": "The App is mounted and has been reloaded in the current OpenGrove instance.",
  "app.import.legacy_ui_rejected":
    "This App uses an unsupported UI format. Migrate it to a supported ui.surface value before importing.",
  "app.import.manifest_needs_fix":
    "This directory is not yet a mountable OpenGrove App. Fix its manifest before importing it.",
  "app.import.mounted": "The App is mounted and loaded in the current OpenGrove instance.",
  "app.import.needs_app_selection":
    "This directory contains multiple importable Apps. Choose one or select a more specific directory.",
  "app.import.needs_local_stage": "Download or clone the remote source to a local directory before importing it.",
  "app.import.needs_source":
    "An App source is required. Provide a local directory, Git/GitHub URL, archive URL, or creation brief.",
  "app.import.source_missing": "The local directory does not exist. Choose another directory.",
  "app.import.source_not_directory": "The App source must be a directory.",
  "app.readiness.asset": "{label} needs an asset directory. {detail}",
  "app.readiness.cli": "{label} is unavailable. {detail}",
  "app.readiness.found": "I found:",
  "app.readiness.item": "{label}: {detail}",
  "app.readiness.more": "There are {count} more items in the readiness report.",
  "app.readiness.not_ready": "{title} is installed, but it is not fully ready yet.",
  "app.readiness.provider": "{label} is not configured. {detail}",
  "app.readiness.ready": "{title} is installed and passed its readiness check. No blocking issues were found.",
  "app.readiness.runtime": "{label} needs its runtime dependencies prepared. {detail}",
  "app.readiness.safety":
    "I can handle local-only writes and read-only network checks first. I will ask separately before choosing directories, configuring keys, changing production systems, spending money, or disabling anything.",
  "app.setup.builder_unavailable":
    "Your custom-interface choice was saved. The App Builder is temporarily unavailable; continue here when the model is available again.",
  "app.setup.created":
    'The team for "{title}" is ready. Choose whether to use the built-in workbench or build a custom interface from scratch.',
  "app.setup.created_with_goal":
    'The team for "{title}" is ready. Your goal has been saved: "{description}". Choose whether to use the built-in workbench or build a custom interface from scratch.',
  "app.setup.custom_choice":
    'I want to create an OpenGrove App named "{title}" with a custom interface.\nFirst, explain what you can do for this App. Let’s clarify the requirements and goals before deciding how to begin.',
  "app.setup.custom_choice_with_description":
    'I want to create an OpenGrove App named "{title}" with a custom interface.\nMy initial idea is: {description}\nFirst, explain what you can do for this App. Let’s clarify the requirements and goals before deciding how to begin.',
  "app.setup.file_workbench_choice": "I choose the built-in OpenGrove workbench UI.",
  "app.setup.imported":
    '"{title}" was imported and mounted. You can now use its employees and workflows in this App group.',
  "artifact.annotation_title": "Annotation · {parent}",
  "dashboard.chapter": "Chapter {chapter}",
  "desktop.choose_app_folder": "Choose an App folder",
  "desktop.export_diagnostics": "Export OpenGrove diagnostics bundle",
  "dialog.import_app_files": "Choose files to import into the current App workspace",
  "dialog.import_folder": "Choose a folder to import",
  "room.app_group_title": "{appTitle} group",
  "room.app_group_title_sequence": "{appTitle} group {sequence}",
  "room.compaction_finished": "Context compacted automatically",
  "room.compaction_started": "Compacting context automatically",
  "room.delegate_employee": "Delegate employee",
  "room.delegation_failed": "The delegated task could not be started.",
  "room.human_member_no_reply": "{name} is a human member and will not generate an automatic agent reply.",
  "room.local_badge": "Local",
  "room.member_not_runnable": "{name} is not currently a runnable local agent.",
  "room.member_removed": "{name} has been removed and cannot participate in this conversation.",
  "room.member_idle": "Idle",
  "room.member_running": "Running",
  "room.member_waiting": "Waiting",
  "room.new_group_title": "New group {sequence}",
  "room.pm_auto_route_unavailable":
    "The current PM cannot auto-route this message. Mention the appropriate employee directly, or make the PM a room administrator and use a kernel with Host Tools.",
  "kernel.provider_selection_required":
    "No Provider is selected for model {model}. Set the model's default Provider in Settings.",
  "kernel.login_unavailable":
    "The selected Login is not available for {kernel}. Sign in with that Kernel, or choose a Provider in Settings.",
  "kernel.route_unavailable": "{kernel} is not available. {reason}",
  "kernel.runtime_unavailable": "No usable {kernel} executable or runtime was found.",
  "room.provider_selection_required":
    "No Provider is selected for model {model}. Choose a Provider for this employee, or set the model's default Provider in Settings.",
  "room.provider_unavailable":
    "The selected Provider {provider} is not usable ({status}). Check its credentials or choose another Provider.",
  "room.provider_status_disabled": "disabled",
  "room.provider_status_missing_key": "credentials missing",
  "room.provider_status_missing_provider": "configuration missing",
  "room.provider_status_unknown": "configuration missing",
  "room.provider_status_unsupported": "model or Kernel unsupported",
  "room.kernel_capabilities_invalid":
    "This employee declares unsupported Kernel capabilities for {kernel}: {capabilities}. Update or reinstall the App before running it.",
  "room.kernel_capabilities_missing":
    "{kernel} has not proven the capabilities required by this employee: {capabilities}. Choose a compatible Kernel or verify its runtime support.",
  "room.reply_target_required":
    "This message does not specify an employee to reply. Mention an employee in the group, or enter @everyone.",
  "room.run_canceled": "This reply was canceled.",
  "room.run_empty": "This run did not return a displayable reply.",
  "room.run_failed": "This run failed. Check the run details.",
  "room.run_inactive": "This run stopped without returning a final result. Please send it again.",
  "room.run_host_restarted": "This run was interrupted because the local service restarted. Please send it again.",
  "workspace.new_folder": "New folder",
  "workspace.untitled_markdown": "Untitled.md",
  "workspace.untitled_note": "Untitled",
} as const;
