import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { defaultAppGitignore, ensureAppBuildContract } from "./build-contract-scaffold.js";

export interface ImportProjectOptions {
  id?: string;
  title?: string;
  description?: string;
  target?: string;
  appsDir?: string;
  force?: boolean;
}

export interface ImportedProjectApp {
  ok: true;
  source: string;
  appRoot: string;
  bundledSource: string;
  manifestPath: string;
  skillPath: string;
  cliPath: string;
  workspacePath: string;
  gitInitialized: boolean;
}

export type AppGitInitStatus = "initialized" | "already_in_repo" | "skipped";

/**
 * Safety net so packages keep provenance: init a repo at the App root with an
 * initial commit. Skips nested-repo situations and degrades silently when git
 * is unavailable — App creation must never fail because of git.
 */
export function ensureAppGitRepo(appRoot: string): AppGitInitStatus {
  const inRepo = gitResult(appRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo === "true") return "already_in_repo";
  if (gitResult(appRoot, ["init", "--quiet"]) === undefined) return "skipped";
  gitResult(appRoot, ["add", "-A"]);
  const committed = gitResult(appRoot, [
    "-c",
    "user.name=OpenGrove",
    "-c",
    "user.email=opengrove@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Initial OpenGrove App commit",
  ]);
  return committed === undefined && gitResult(appRoot, ["rev-parse", "HEAD"]) === undefined ? "skipped" : "initialized";
}

function gitResult(cwd: string, args: string[]): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function importProjectAsApp(source: string, options: ImportProjectOptions = {}): ImportedProjectApp {
  const sourceRoot = resolvePathLike(source);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new Error("import source must be an existing local directory");
  }

  const id = normalizeAppId(options.id || sourceId(sourceRoot));
  const title = options.title || titleFromName(id);
  const target = resolveImportTarget(id, options);
  if (existsSync(target) && readdirSync(target).length > 0 && !options.force) {
    throw new Error("target already exists and is not empty; pass --force to overwrite");
  }
  if (options.force) rmSync(target, { recursive: true, force: true });

  const bundledDirName = bundledSourceDirectoryName(sourceRoot);
  const bundledSource = join(target, bundledDirName);
  const workspacePath = join(target, "workspace");
  const skillName = `${id}-operator`;
  const cliName = id;
  const cliPath = join(target, "bin", cliName);
  const skillPath = join(target, "skills", skillName, "SKILL.md");
  const manifestPath = join(target, "opengrove.app.json");

  mkdirSync(dirname(bundledSource), { recursive: true });
  copyImportSource(sourceRoot, bundledSource);
  rewriteBundledSourceReferences(sourceRoot, bundledSource);
  mkdirSync(join(workspacePath, "runs"), { recursive: true });
  mkdirSync(join(target, "bin"), { recursive: true });
  mkdirSync(join(target, "tools"), { recursive: true });
  mkdirSync(dirname(skillPath), { recursive: true });

  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      importManifest({
        id,
        title,
        description: options.description,
        skillName,
        cliName,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(cliPath, importedCliWrapperText({ bundledDirName }), "utf8");
  chmodSync(cliPath, 0o755);
  writeFileSync(join(target, "tools", "app_status.py"), importedStatusToolText({ bundledDirName }), "utf8");
  writeFileSync(skillPath, importedSkillText({ id: skillName, title, cliName, bundledDirName }), "utf8");
  writeFileSync(join(target, "AGENTS.md"), importedAgentsText({ title, skillName, cliName, bundledDirName }), "utf8");
  writeFileSync(join(workspacePath, "runs", ".gitkeep"), "", "utf8");
  writeFileSync(join(workspacePath, "README.md"), workspaceReadmeText(), "utf8");
  writeFileSync(join(workspacePath, "runs", "README.md"), workspaceRunsReadmeText(), "utf8");
  writeFileSync(join(target, ".gitignore"), importGitignoreText(bundledDirName), "utf8");
  ensureAppBuildContract(target);
  writeFileSync(join(target, "IMPORT_NOTES.md"), importNotesText({ bundledDirName }), "utf8");
  writeFileSync(join(target, "README.md"), importedReadmeText({ title, cliName, bundledDirName }), "utf8");
  const gitInitialized = ensureAppGitRepo(target) === "initialized";

  return {
    ok: true,
    source,
    appRoot: target,
    bundledSource,
    manifestPath,
    skillPath,
    cliPath,
    workspacePath,
    gitInitialized,
  };
}

function importManifest(input: {
  id: string;
  title: string;
  description?: string;
  skillName: string;
  cliName: string;
}) {
  return {
    id: input.id,
    title: input.title,
    description: input.description || `${input.title} imported workflow for OpenGrove.`,
    version: "0.1.0",
    ui: {
      surface: "file-workbench",
      workspace: "workspace",
      agentContext: `This imported App bundles its source project internally. Use ${input.cliName} status, doctor, smoke, project-status, top10, serve, or run -- <command> to inspect and operate it. Keep user-visible OpenGrove audit outputs under workspace/runs/. Native pipeline outputs may remain in the bundled project's established outputs directories.`,
    },
    workspace: {
      path: "workspace",
    },
    skills: {
      roots: [`skills/${input.skillName}`],
    },
    employees: [
      {
        id: "operator",
        name: `${input.title} Operator`,
        role: `Operates the ${input.title} imported workflow App and keeps user-visible audit outputs under workspace/runs.`,
        defaultSkillIds: [input.skillName],
        availableSkillIds: [input.skillName],
      },
    ],
    capabilities: {
      skills: [input.skillName],
      cli: [
        {
          id: input.cliName,
          title: input.title,
          description: "Operate the bundled imported workflow project.",
          command: `./bin/${input.cliName}`,
          doctor: ["doctor"],
          smoke: ["smoke"],
          commands: [
            "status",
            "doctor",
            "smoke",
            "list-projects",
            "project-status",
            "serve",
            "project-init",
            "batch-prepare",
            "top10",
            "run",
          ],
          env: [
            "GEMINI_API_KEY",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "OPENGROVE_APP_WORKSPACE",
            "OPENGROVE_APP_PYTHON",
            "PYTHON",
          ],
          artifacts: [
            "workspace/runs/**",
            "source-project/projects/**/outputs/**",
            "auto-edit-project/projects/**/outputs/**",
          ],
          allowNativeBash: true,
        },
      ],
    },
    runtimeEnv: {
      providerKeys: [
        {
          providerId: "gemini",
          env: {
            apiKey: ["GEMINI_API_KEY"],
          },
          required: false,
        },
      ],
    },
    agent: {
      instructions:
        "Run status, doctor, and smoke before generation. Keep OpenGrove audit logs under workspace/runs. Do not write secrets into the App; pass provider keys through environment variables.",
    },
  };
}

function importedAgentsText(input: {
  title: string;
  skillName: string;
  cliName: string;
  bundledDirName: string;
}): string {
  return `# ${input.title} App Agent

You are the bound employee for this imported OpenGrove App.

- Read opengrove.app.json before changing the App workflow.
- Use the ${input.skillName} skill for App-specific tasks.
- Use ./bin/${input.cliName} for declared status, doctor, smoke, and workflow commands.
- Keep OpenGrove-facing outputs inside workspace/runs.
- Treat files under ${input.bundledDirName}/ as bundled workflow source; avoid changing them unless the user asks to modify the App itself.
- Report missing API keys, model files, local tools, or system dependencies as configuration gaps.
`;
}

function importedCliWrapperText(input: { bundledDirName: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail

SOURCE="\${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$SOURCE_DIR/$SOURCE"
done
APP_ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
PROJECT_ROOT="$APP_ROOT/${input.bundledDirName}"
WORKSPACE_ROOT="\${OPENGROVE_APP_WORKSPACE:-$APP_ROOT/workspace}"
PYTHON_BIN="\${OPENGROVE_APP_PYTHON:-python3}"
export APP_ROOT PROJECT_ROOT WORKSPACE_ROOT PYTHONDONTWRITEBYTECODE=1

usage() {
  cat <<'EOF'
Usage: imported-app <command> [args]

Commands:
  status [--json]
      Print an App inventory and health report.
  doctor
      Check bundled project, local tools, sample media, and excluded material.
  smoke [--output DIR]
      Stage a short sample clip and run note into workspace/runs.
  list-projects
      List bundled project directories under <source>/projects.
  project-status [PROJECT|--project PROJECT]
      Print project status using src/project_compat.py when available.
  serve [args...]
      Start src/api_server.py when present.
  project-init [args...]
      Run src/project_init.py when present.
  batch-prepare [args...]
      Run src/batch_prepare_all.py when present.
  top10 [args...]
      Run src/batch_top10.py when present.
  run -- <command...>
      Run an arbitrary command from the bundled source project root.
EOF
}

first_file() {
  local pattern="$1"
  local found
  found="$(
    cd "$PROJECT_ROOT" && \
      find . \
        -path './clip_generator_tmp' -prune -o \
        -path './*/clip_generator_tmp' -prune -o \
        -path './*/tmp' -prune -o \
        -type f -name "$pattern" -print 2>/dev/null \
      | sed 's#^\./##' \
      | sort \
      | head -1
  )"
  [[ -n "$found" ]] && printf '%s/%s\n' "$PROJECT_ROOT" "$found"
}

project_dir_for_ref() {
  local ref="\${1:-}"
  if [[ -n "$ref" && -d "$ref" ]]; then
    (cd "$ref" && pwd -P)
    return
  fi
  if [[ -z "$ref" ]]; then
    find "$PROJECT_ROOT/projects" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | head -1
    return
  fi
  if [[ "$ref" =~ ^[0-9]+$ ]]; then
    ref="#$ref#"
  fi
  local candidate="$PROJECT_ROOT/projects/$ref"
  [[ -d "$candidate" ]] && { (cd "$candidate" && pwd -P); return; }
  echo "Project not found: $ref" >&2
  exit 1
}

cmd_app_status() {
  if [[ -f "$APP_ROOT/tools/app_status.py" ]]; then
    "$PYTHON_BIN" "$APP_ROOT/tools/app_status.py" "$@"
    return
  fi
  echo "app_root=$APP_ROOT"
  echo "project_root=$PROJECT_ROOT"
  echo "workspace_root=$WORKSPACE_ROOT"
  for tool in "$PYTHON_BIN" ffmpeg ffprobe node; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "$tool=$(command -v "$tool")"
    else
      echo "$tool=missing"
    fi
  done
  [[ -f "$PROJECT_ROOT/requirements.txt" ]] && echo "requirements=present" || echo "requirements=missing"
  [[ -d "$PROJECT_ROOT/src" ]] && echo "src=present" || echo "src=missing"
  [[ -d "$PROJECT_ROOT/scripts" ]] && echo "scripts=present" || echo "scripts=missing"
  [[ -d "$PROJECT_ROOT/web" ]] && echo "web=present" || echo "web=missing"
  echo "project_count=$(find "$PROJECT_ROOT/projects" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  local sample
  sample="$(first_file '*.mp4' || true)"
  if [[ -n "$sample" ]]; then
    echo "sample_video=$sample"
    command -v ffprobe >/dev/null 2>&1 && ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 "$sample" || true
  else
    echo "sample_video=missing"
  fi
}

cmd_doctor() {
  if [[ -f "$APP_ROOT/tools/app_status.py" ]]; then
    "$PYTHON_BIN" "$APP_ROOT/tools/app_status.py" --doctor
  else
    cmd_app_status
  fi
}

cmd_smoke() {
  local output_dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output) output_dir="$2"; shift 2 ;;
      *) echo "Unknown smoke option: $1" >&2; exit 2 ;;
    esac
  done
  local run_id sample image project_dir
  run_id="import-smoke-$(date +%Y%m%d-%H%M%S)"
  output_dir="\${output_dir:-$WORKSPACE_ROOT/runs/$run_id}"
  sample="$(first_file '*.mp4' || true)"
  image="$(first_file 'cover_*.jpg' || first_file '*.jpg' || first_file '*.png' || true)"
  [[ -n "$sample" ]] || { echo "No sample mp4 found in bundled project." >&2; exit 1; }
  mkdir -p "$output_dir/assets" "$output_dir/docs"
  if [[ -f "$APP_ROOT/tools/app_status.py" ]]; then
    "$PYTHON_BIN" "$APP_ROOT/tools/app_status.py" --json >"$output_dir/status.json" || true
  fi
  if [[ -f "$PROJECT_ROOT/src/project_compat.py" ]]; then
    project_dir="$(project_dir_for_ref "")"
    [[ -n "$project_dir" ]] && (cd "$PROJECT_ROOT" && "$PYTHON_BIN" src/project_compat.py status --project "$project_dir" >"$output_dir/project-status.json") || true
  fi
  "$PYTHON_BIN" - <<'PY' >"$output_dir/py_compile.log" 2>&1 || true
import os
from pathlib import Path

project_root = Path(os.environ["PROJECT_ROOT"])
src_root = project_root / "src"
checked = 0
failed = 0
for name in ["project_compat.py", "batch_top10.py", "api_server.py"]:
    path = src_root / name
    if not path.exists():
        continue
    try:
        compile(path.read_text(encoding="utf-8", errors="replace"), str(path), "exec")
        print(f"OK {path.relative_to(project_root)}")
        checked += 1
    except Exception as exc:
        failed += 1
        print(f"FAIL {path.relative_to(project_root)}: {exc}")
print(f"checked={checked} failed={failed}")
raise SystemExit(1 if failed else 0)
PY
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -v error -y -i "$sample" -t 8 -map 0:v:0 -map 0:a? -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "$output_dir/assets/sample-clip.mp4" || cp "$sample" "$output_dir/assets/sample-clip.mp4"
  else
    cp "$sample" "$output_dir/assets/sample-clip.mp4"
  fi
  [[ -n "$image" ]] && cp "$image" "$output_dir/assets/preview$(printf '%s' "$image" | sed 's/^.*\\.//;s/^/./')"
  command -v ffprobe >/dev/null 2>&1 && ffprobe -v error -show_format -show_streams -of json "$output_dir/assets/sample-clip.mp4" >"$output_dir/assets/sample-clip.ffprobe.json" || true
  cat >"$output_dir/docs/run-note.md" <<EOF
# Imported App Smoke Run

- Bundled project: $PROJECT_ROOT
- Source video: $sample
- Output video: assets/sample-clip.mp4

This smoke run stages a short preview from the bundled project so OpenGrove's
file workbench can verify Markdown, media, and file previews.
EOF
  echo "$output_dir"
}

cmd_list_projects() {
  find "$PROJECT_ROOT/projects" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort
}

cmd_project_status() {
  local project_dir
  project_dir="$(project_dir_for_ref "\${1:-}")"
  if [[ -f "$PROJECT_ROOT/src/project_compat.py" ]]; then
    (cd "$PROJECT_ROOT" && "$PYTHON_BIN" src/project_compat.py status --project "$project_dir")
  else
    echo "{\"project_dir\":\"$project_dir\"}"
  fi
}

cmd_project_status_arg() {
  local project_ref="\${1:-}"
  if [[ "$project_ref" == "--project" ]]; then
    project_ref="\${2:-}"
  fi
  cmd_project_status "$project_ref"
}

run_python_script() {
  local script="$1"
  shift
  if [[ ! -f "$PROJECT_ROOT/src/$script" ]]; then
    echo "Missing script: src/$script" >&2
    exit 1
  fi
  (cd "$PROJECT_ROOT" && "$PYTHON_BIN" "src/$script" "$@")
}

case "\${1:-help}" in
  status) shift; cmd_app_status "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  smoke) shift; cmd_smoke "$@" ;;
  list-projects) shift; cmd_list_projects "$@" ;;
  project-status) shift; cmd_project_status_arg "$@" ;;
  serve) shift; run_python_script api_server.py "$@" ;;
  project-init) shift; run_python_script project_init.py "$@" ;;
  batch-prepare) shift; run_python_script batch_prepare_all.py "$@" ;;
  top10) shift; run_python_script batch_top10.py "$@" ;;
  run)
    shift
    [[ "\${1:-}" == "--" ]] && shift
    (cd "$PROJECT_ROOT" && "$@")
    ;;
  help|-h|--help) usage ;;
  *) echo "Unknown command: \${1:-}" >&2; usage >&2; exit 2 ;;
esac
`;
}

function importedSkillText(input: { id: string; title: string; cliName: string; bundledDirName: string }): string {
  return `---
name: ${input.id}
description: Operate the imported ${input.title} App, including inspecting the bundled source project, running its wrapper, and staging previewable outputs in the App workspace.
allowed-tools:
  - Bash
shell:
  - \${OPENGROVE_SKILL_DIR}/../../bin/${input.cliName}
  - python3
  - node
  - ffmpeg
  - ffprobe
paths:
  - \${OPENGROVE_SKILL_DIR}/../..
---

# ${input.title}

The imported source project is bundled at:

\`\`\`text
\${OPENGROVE_SKILL_DIR}/../../${input.bundledDirName}
\`\`\`

Prefer the App wrapper:

\`\`\`bash
\${OPENGROVE_SKILL_DIR}/../../bin/${input.cliName} doctor
\${OPENGROVE_SKILL_DIR}/../../bin/${input.cliName} smoke
\${OPENGROVE_SKILL_DIR}/../../bin/${input.cliName} status --json
\${OPENGROVE_SKILL_DIR}/../../bin/${input.cliName} list-projects
\${OPENGROVE_SKILL_DIR}/../../bin/${input.cliName} project-status
\`\`\`

For imported Python workflow projects, common optional commands are:

- \`serve\` to start \`src/api_server.py\` when present.
- \`project-init\` to run \`src/project_init.py\` when present.
- \`batch-prepare\` to run \`src/batch_prepare_all.py\` when present.
- \`top10\` to run \`src/batch_top10.py\` when present.
- \`run -- <command...>\` for lower-level source project commands.

Keep OpenGrove audit logs inside \`workspace/runs/\`. Native production outputs
may remain in the bundled source project's established \`outputs/\` folders.
Report missing API keys, model credentials, or local binaries as runtime
configuration gaps.
`;
}

function importedStatusToolText(input: { bundledDirName: string }): string {
  return `#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


APP_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = APP_ROOT / "${input.bundledDirName}"
TEMP_DIR_NAMES = {"tmp", "clip_generator_tmp", "__pycache__", ".cache", "cache"}
SECRET_FILE_NAMES = {".env"}


def rel(path: Path) -> str:
    try:
        return path.relative_to(APP_ROOT).as_posix()
    except ValueError:
        return str(path)


def command_version(command: str, args: list[str]) -> dict[str, Any]:
    executable = shutil.which(command)
    if not executable:
        return {"available": False, "path": None, "version": None}
    try:
        result = subprocess.run(
            [executable, *args],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=5,
        )
        first_line = (result.stdout or "").splitlines()[0] if result.stdout else ""
    except Exception as exc:
        first_line = f"version check failed: {exc}"
    return {"available": True, "path": executable, "version": first_line}


def count(pattern: str) -> int:
    return sum(1 for _ in PROJECT_ROOT.glob(pattern))


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def project_summary(project_dir: Path) -> dict[str, Any]:
    project_json = load_json(project_dir / "project.json") or {}
    outputs = project_dir / "outputs"
    return {
        "path": rel(project_dir),
        "project_id": project_json.get("project_id") or project_dir.name,
        "title": project_json.get("title", ""),
        "source_videos": sum(1 for _ in (project_dir / "source" / "videos").glob("**/*.mp4")),
        "episode_json": sum(1 for _ in (project_dir / "data" / "episodes").glob("*.json")),
        "docs": sum(1 for _ in (project_dir / "docs").glob("*.md")),
        "final_mp4": sum(1 for _ in outputs.glob("final*/**/*.mp4")) if outputs.exists() else 0,
        "has_highlight_plan": (project_dir / "highlight_plan.json").exists(),
        "has_story_profile": (project_dir / "project_story_profile.json").exists(),
        "has_variant_strategy": (project_dir / "variant_strategy.json").exists(),
    }


def scan_disallowed() -> tuple[list[str], list[str]]:
    temp_dirs: list[str] = []
    secret_files: list[str] = []
    for path in PROJECT_ROOT.rglob("*"):
        if path.is_dir() and path.name in TEMP_DIR_NAMES:
            temp_dirs.append(rel(path))
        elif path.is_file():
            if path.name in SECRET_FILE_NAMES or path.name.startswith(".env."):
                secret_files.append(rel(path))
    return sorted(temp_dirs), sorted(secret_files)


def build_status() -> dict[str, Any]:
    projects_root = PROJECT_ROOT / "projects"
    projects = sorted([p for p in projects_root.iterdir() if p.is_dir()]) if projects_root.exists() else []
    temp_dirs, secret_files = scan_disallowed() if PROJECT_ROOT.exists() else ([], [])
    runtime = {
        "python": {"available": True, "path": sys.executable, "version": platform.python_version()},
        "ffmpeg": command_version("ffmpeg", ["-version"]),
        "ffprobe": command_version("ffprobe", ["-version"]),
        "node": command_version("node", ["--version"]),
    }

    critical: list[str] = []
    warnings: list[str] = []
    for required in ["opengrove.app.json", "${input.bundledDirName}"]:
        if not (APP_ROOT / required).exists():
            critical.append(f"missing required app file or directory: {required}")
    for required in ["src", "config", "projects", "requirements.txt"]:
        if not (PROJECT_ROOT / required).exists():
            warnings.append(f"bundled source is missing expected path: {required}")
    if temp_dirs:
        critical.append("disallowed temp/cache directories are present")
    if secret_files:
        critical.append("secret environment files are present")
    if not runtime["ffmpeg"]["available"]:
        warnings.append("ffmpeg is not on PATH; rendering commands will fail until installed")
    if not os.environ.get("GEMINI_API_KEY"):
        warnings.append("GEMINI_API_KEY is not set; LLM generation commands may require it")
    if not projects:
        warnings.append("no imported projects found under bundled source projects/")

    return {
        "app_root": str(APP_ROOT),
        "project_root": str(PROJECT_ROOT),
        "manifest": {
            "path": rel(APP_ROOT / "opengrove.app.json") if (APP_ROOT / "opengrove.app.json").exists() else None,
            "exists": (APP_ROOT / "opengrove.app.json").exists(),
            "id": (load_json(APP_ROOT / "opengrove.app.json") or {}).get("id") if (APP_ROOT / "opengrove.app.json").exists() else None,
        },
        "runtime": runtime,
        "inventory": {
            "python_scripts": count("src/*.py"),
            "node_scripts": count("scripts/*.js"),
            "config_files": count("config/**/*.json") + count("config/**/*.yaml") + count("config/**/*.yml"),
            "docs": count("*.md") + count("docs/**/*.md"),
            "web_files": count("web/*"),
            "source_videos": count("projects/*/source/videos/**/*.mp4"),
            "final_videos": count("projects/*/outputs/final*/**/*.mp4"),
            "workspace_runs": sum(1 for _ in (APP_ROOT / "workspace" / "runs").glob("*")) if (APP_ROOT / "workspace" / "runs").exists() else 0,
        },
        "projects": [project_summary(project) for project in projects],
        "disallowed": {"temp_dirs": temp_dirs, "secret_files": secret_files},
        "critical": critical,
        "warnings": warnings,
        "ok": not critical,
    }


def print_human(status: dict[str, Any], doctor: bool) -> None:
    label = "Doctor" if doctor else "Status"
    print(f"Imported App {label}")
    print(f"App root: {status['app_root']}")
    print(f"Bundled project: {status['project_root']}")
    print(f"Manifest: {status['manifest']['path'] or 'missing'}")
    print("")
    print("Inventory:")
    for key, value in status["inventory"].items():
        print(f"  {key}: {value}")
    print("")
    print("Runtime:")
    for key, value in status["runtime"].items():
        available = "yes" if value["available"] else "no"
        version = value.get("version") or ""
        print(f"  {key}: {available} {version}".rstrip())
    print("")
    print("Projects:")
    if status["projects"]:
        for project in status["projects"]:
            print(
                "  {project_id}: {source_videos} source videos, {final_mp4} final mp4, "
                "highlight={has_highlight_plan}, profile={has_story_profile}, strategy={has_variant_strategy}".format(**project)
            )
    else:
        print("  none")
    if status["warnings"]:
        print("")
        print("Warnings:")
        for item in status["warnings"]:
            print(f"  - {item}")
    if status["critical"]:
        print("")
        print("Critical issues:")
        for item in status["critical"]:
            print(f"  - {item}")
    print("")
    print("OK" if status["ok"] else "NOT OK")


def main() -> int:
    parser = argparse.ArgumentParser(description="Report imported OpenGrove App inventory and health.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    parser.add_argument("--doctor", action="store_true", help="Print doctor report and fail on critical issues.")
    args = parser.parse_args()
    status = build_status()
    if args.json:
        print(json.dumps(status, indent=2, ensure_ascii=False))
    else:
        print_human(status, doctor=args.doctor)
    return 0 if status["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

function importedReadmeText(input: { title: string; cliName: string; bundledDirName: string }): string {
  return `# ${input.title}

Imported OpenGrove App.

## Layout

\`\`\`text
${input.bundledDirName}/   # bundled source project
bin/${input.cliName}       # App wrapper
skills/                    # agent-facing operating instructions
workspace/runs/            # previewable App outputs
\`\`\`

## Checks

\`\`\`bash
./bin/${input.cliName} doctor
./bin/${input.cliName} smoke
./bin/${input.cliName} list-projects
./bin/${input.cliName} status --json
./bin/${input.cliName} project-status
\`\`\`
`;
}

function workspaceReadmeText(): string {
  return `# Workspace

This directory is the OpenGrove-visible workspace for imported App audit logs,
smoke outputs, previews, and short run notes.

Native pipeline artifacts may still be written by the bundled source project to
its own established output folders.
`;
}

function workspaceRunsReadmeText(): string {
  return `# Runs

Generated App run artifacts are written here by wrapper commands such as
\`smoke\`. These files are disposable and can be regenerated.
`;
}

function importNotesText(input: { bundledDirName: string }): string {
  return `# Import Notes

This OpenGrove App was generated from a local source project.

Included:

- Bundled source project in \`${input.bundledDirName}/\`
- App manifest, wrapper CLI, operator skill, workspace, and status tool
- Existing project data and outputs that were not classified as temporary cache

Excluded by default:

- \`.env\` and \`.env.*\`
- \`.git\`, virtual environments, \`node_modules\`
- \`.DS_Store\`, \`__pycache__\`, \`*.pyc\`, cache directories
- \`tmp/\`, \`clip_generator_tmp/\`, \`outputs/packaged_ads/\`, \`outputs/ab_tests/\`

Run:

\`\`\`bash
./bin/* doctor
./bin/* smoke
\`\`\`
`;
}

function importGitignoreText(bundledDirName: string): string {
  return `${defaultAppGitignore()}
${bundledDirName}/clip_generator_tmp/
${bundledDirName}/projects/*/tmp/
${bundledDirName}/projects/*/outputs/packaged_ads/
${bundledDirName}/projects/*/outputs/ab_tests/
`;
}

function copyImportSource(sourceRoot: string, target: string): void {
  cpSync(sourceRoot, target, {
    recursive: true,
    filter: (path) => shouldCopyImportPath(sourceRoot, path),
  });
}

const REWRITE_TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

function rewriteBundledSourceReferences(sourceRoot: string, bundledSource: string): void {
  const sourceNeedles = uniqueStrings([sourceRoot, realpathIfPossible(sourceRoot)]);
  const bundledRoot = realpathIfPossible(bundledSource);
  for (const file of listRewriteCandidateFiles(bundledSource)) {
    const original = readFileSync(file, "utf8");
    if (!containsPathReference(original, sourceNeedles)) continue;
    if (extname(file).toLowerCase() === ".json") {
      const rewrittenJson = rewriteJsonFile(original, sourceNeedles, bundledRoot);
      if (rewrittenJson !== original) writeFileSync(file, rewrittenJson, "utf8");
      continue;
    }
    const rewritten = replaceAllPathReferences(original, sourceNeedles, bundledRoot);
    if (rewritten !== original) writeFileSync(file, rewritten, "utf8");
  }
}

function listRewriteCandidateFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (REWRITE_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
    }
  };
  visit(root);
  return files;
}

function rewriteJsonFile(source: string, sourceNeedles: string[], bundledRoot: string): string {
  try {
    JSON.parse(source);
  } catch {
    return replaceAllPathReferences(source, sourceNeedles, bundledRoot);
  }

  // Edit only JSON string tokens. Re-serializing the parsed document would
  // reformat unrelated files and can round integer literals beyond JS's safe
  // range even when no path reference changed.
  let cursor = 0;
  let rewritten = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '"') continue;
    const tokenStart = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === '"') break;
      index += 1;
    }
    const token = source.slice(tokenStart, index + 1);
    const value = JSON.parse(token) as string;
    const nextValue = replaceAllPathReferences(value, sourceNeedles, bundledRoot);
    if (nextValue === value) continue;
    rewritten += source.slice(cursor, tokenStart);
    rewritten += JSON.stringify(nextValue);
    cursor = index + 1;
  }
  return cursor > 0 ? `${rewritten}${source.slice(cursor)}` : source;
}

function replaceAllPathReferences(source: string, sourceNeedles: string[], bundledRoot: string): string {
  let rewritten = source;
  for (const needle of sourceNeedles) {
    let cursor = 0;
    let next = "";
    while (cursor < rewritten.length) {
      const match = rewritten.indexOf(needle, cursor);
      if (match < 0) {
        next += rewritten.slice(cursor);
        break;
      }
      const endIndex = match + needle.length;
      next += rewritten.slice(cursor, match);
      if (isPathReferenceStartBoundary(rewritten[match - 1]) && isPathReferenceEndBoundary(rewritten, endIndex)) {
        next += bundledRoot;
      } else {
        next += needle;
      }
      cursor = match + needle.length;
    }
    rewritten = next;
  }
  return rewritten;
}

function containsPathReference(source: string, sourceNeedles: string[]): boolean {
  return sourceNeedles.some(
    (needle) =>
      source.includes(needle) ||
      source.includes(JSON.stringify(needle).slice(1, -1)) ||
      source.includes(JSON.stringify(needle).slice(1, -1).replaceAll("/", "\\/")),
  );
}

function isPathReferenceStartBoundary(value: string | undefined): boolean {
  return value === undefined || value === "/" || value === "\\" || /[\s"'`({\[,:;=]/.test(value);
}

function isPathReferenceEndBoundary(source: string, index: number): boolean {
  const value = source[index];
  if (value === ".") {
    let punctuationEnd = index + 1;
    while (source[punctuationEnd] === ".") punctuationEnd += 1;
    const afterPunctuation = source[punctuationEnd];
    return afterPunctuation === undefined || /[\s"'`),:;\]}]/.test(afterPunctuation);
  }
  return value === undefined || value === "/" || value === "\\" || /[\s"'`),:;\]}?#&]/.test(value);
}

function realpathIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function shouldCopyImportPath(sourceRoot: string, path: string): boolean {
  const relativePath = path === sourceRoot ? "" : path.slice(sourceRoot.length + 1);
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || basename(path);
  if (!name) return true;
  if (name === ".git" || name === "node_modules" || name === ".venv" || name === "venv") return false;
  if (name === "__pycache__" || name === ".DS_Store" || name === ".cache" || name === "cache") return false;
  if (name.endsWith(".pyc") || name.endsWith(".pyo")) return false;
  if (/^\.env(?:\.|$)/.test(name)) return false;
  if (parts.includes("clip_generator_tmp")) return false;
  if (parts.includes("tmp")) return false;
  if (parts.includes("packaged_ads") || parts.includes("ab_tests")) return false;
  return true;
}

function resolveImportTarget(id: string, options: ImportProjectOptions): string {
  if (options.target) return resolvePathLike(options.target);
  const appsDir = options.appsDir ? resolvePathLike(options.appsDir) : resolve("data", "apps");
  return resolve(appsDir, id);
}

function bundledSourceDirectoryName(sourceRoot: string): string {
  const base = basename(sourceRoot);
  if (base.includes("自动剪辑") || base.toLowerCase().includes("auto-edit")) return "auto-edit-project";
  return "source-project";
}

function sourceId(source: string): string {
  const base = basename(source).replace(/\.(zip|tar|tgz|gz)$/i, "");
  if (base.includes("自动剪辑")) return "auto-edit-project";
  return base || "opengrove-app";
}

function normalizeAppId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "opengrove-app";
}

function titleFromName(name: string): string {
  return name
    .split(/[-_:.\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function resolvePathLike(path: string): string {
  if (path === "~") return resolve(homedir());
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}
