import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomChannelMember } from "../rooms/channel-store.js";
import type { BridgeState } from "../server/bridge-types.js";
import { roomAgentAppVersionKey, roomAgentThreadId } from "../server/room-runs/execution-state.js";

const dir = mkdtempSync(join(tmpdir(), "opengrove-room-agent-runtime-fingerprint-"));

try {
  const appRoot = join(dir, "fingerprint-app");
  mkdirSync(join(appRoot, "bin"), { recursive: true });
  mkdirSync(join(appRoot, "commands"), { recursive: true });
  mkdirSync(join(appRoot, "hooks"), { recursive: true });
  mkdirSync(join(appRoot, "mcp"), { recursive: true });
  mkdirSync(join(appRoot, "skills", "worker"), { recursive: true });
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify({
      id: "fingerprint-app",
      title: "Fingerprint App",
      version: "1.0.0",
      employees: [
        {
          id: "worker",
          name: "Worker",
          kernel: "claude-code",
          role: "Worker.",
        },
      ],
    })}\n`,
    "utf8",
  );
  writeFileSync(join(appRoot, "skills", "worker", "SKILL.md"), "# Worker\n\nFirst runtime instructions.\n", "utf8");

  const state = {
    settings: {
      mountedApps: [{ id: "fingerprint-app", path: appRoot, enabled: true }],
    },
  } as BridgeState;
  const target = {
    id: "member-app-fingerprint-app-worker",
    kernel: "claude-code",
    appId: "fingerprint-app",
  } as RoomChannelMember;
  const roomId = "app-room--fingerprint-app--group--default";

  const firstFingerprint = roomAgentAppVersionKey(state, target);
  assert.equal(firstFingerprint, "app-version-1.0.0");
  const firstSessionId = roomAgentThreadId(roomId, target.id, target.kernel, firstFingerprint);
  assert.match(firstSessionId, /-v7-app-version-1-0-0$/);

  writeFileSync(
    join(appRoot, "workspace", "story.md"),
    "Project content should not affect runtime sessions.\n",
    "utf8",
  );
  const workspaceChangedFingerprint = roomAgentAppVersionKey(state, target);
  const workspaceChangedSessionId = roomAgentThreadId(roomId, target.id, target.kernel, workspaceChangedFingerprint);
  assert.equal(workspaceChangedFingerprint, firstFingerprint);
  assert.equal(workspaceChangedSessionId, firstSessionId);

  mkdirSync(join(appRoot, "skills", "worker", "__pycache__"), { recursive: true });
  mkdirSync(join(appRoot, "skills", "worker", "batch_runs"), { recursive: true });
  mkdirSync(join(appRoot, "skills", "worker", "logs"), { recursive: true });
  writeFileSync(join(appRoot, "skills", "worker", "__pycache__", "worker.cpython-313.pyc"), "runtime bytecode", "utf8");
  writeFileSync(join(appRoot, "skills", "worker", "batch_runs", "2026-07-29.json"), '{"status":"complete"}\n', "utf8");
  writeFileSync(join(appRoot, "skills", "worker", "logs", "worker.log"), "runtime log\n", "utf8");
  writeFileSync(join(appRoot, "skills", "worker", "latest.log"), "runtime log beside source\n", "utf8");
  writeFileSync(join(appRoot, "bin", "worker"), "#!/bin/sh\n", "utf8");
  writeFileSync(join(appRoot, "commands", "worker.md"), "# Command\n", "utf8");
  writeFileSync(join(appRoot, "hooks", "worker.json"), "{}\n", "utf8");
  writeFileSync(join(appRoot, "mcp", "worker.json"), "{}\n", "utf8");
  writeFileSync(join(appRoot, "AGENTS.md"), "# App instructions\n", "utf8");
  writeFileSync(join(appRoot, "CLAUDE.md"), "# Claude instructions\n", "utf8");
  const runtimeOutputChangedFingerprint = roomAgentAppVersionKey(state, target);
  const runtimeOutputChangedSessionId = roomAgentThreadId(
    roomId,
    target.id,
    target.kernel,
    runtimeOutputChangedFingerprint,
  );
  assert.equal(runtimeOutputChangedFingerprint, firstFingerprint);
  assert.equal(runtimeOutputChangedSessionId, firstSessionId);

  mkdirSync(join(appRoot, "skills", "logs"), { recursive: true });
  writeFileSync(join(appRoot, "skills", "logs", "SKILL.md"), "# Logs skill\n", "utf8");
  const namedSkillChangedFingerprint = roomAgentAppVersionKey(state, target);
  const namedSkillChangedSessionId = roomAgentThreadId(roomId, target.id, target.kernel, namedSkillChangedFingerprint);
  assert.equal(
    namedSkillChangedFingerprint,
    runtimeOutputChangedFingerprint,
    "Adding a Skill within one App version must not replace the native session.",
  );

  writeFileSync(join(appRoot, "skills", "worker", "SKILL.md"), "# Worker\n\nUpdated runtime instructions.\n", "utf8");
  const runtimeChangedFingerprint = roomAgentAppVersionKey(state, target);
  const runtimeChangedSessionId = roomAgentThreadId(roomId, target.id, target.kernel, runtimeChangedFingerprint);
  assert.equal(
    runtimeChangedFingerprint,
    namedSkillChangedFingerprint,
    "Skill body updates must not replace the native session for the same published App version.",
  );
  assert.equal(runtimeChangedSessionId, namedSkillChangedSessionId);

  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify({
      id: "fingerprint-app",
      title: "Updated Fingerprint App",
      version: "1.0.0",
      employees: [
        {
          id: "worker",
          name: "Worker",
          kernel: "claude-code",
          role: "Worker.",
        },
      ],
    })}\n`,
    "utf8",
  );
  const sameVersionManifestKey = roomAgentAppVersionKey(state, target);
  assert.equal(
    sameVersionManifestKey,
    runtimeChangedFingerprint,
    "Manifest edits without an App version change must keep the native-session boundary stable.",
  );

  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify({
      id: "fingerprint-app",
      title: "Updated Fingerprint App",
      version: "1.1.0",
      employees: [
        {
          id: "worker",
          name: "Worker",
          kernel: "claude-code",
          role: "Worker.",
        },
      ],
    })}\n`,
    "utf8",
  );
  const manifestChangedFingerprint = roomAgentAppVersionKey(state, target);
  assert.notEqual(manifestChangedFingerprint, sameVersionManifestKey);

  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify({
      id: "fingerprint-app",
      title: "Store Fingerprint App",
      employees: [
        {
          id: "worker",
          name: "Worker",
          kernel: "claude-code",
          role: "Worker.",
        },
      ],
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(appRoot, ".opengrove-store-package.json"),
    `${JSON.stringify({
      source: "registry",
      appId: "fingerprint-app",
      version: "2.0.0",
    })}\n`,
    "utf8",
  );
  const installedStoreVersionKey = roomAgentAppVersionKey(state, target);
  assert.equal(
    installedStoreVersionKey,
    "app-version-2.0.0",
    "an installed Store App without manifest.version must use its trusted install-marker version",
  );

  writeFileSync(
    join(appRoot, ".opengrove-store-package.json"),
    `${JSON.stringify({
      source: "registry",
      appId: "fingerprint-app",
      version: "2.1.0",
    })}\n`,
    "utf8",
  );
  assert.equal(
    roomAgentAppVersionKey(state, target),
    "app-version-2.1.0",
    "a Store update must rotate the native-session boundary even when manifest.version is absent",
  );
  assert.equal(roomAgentAppVersionKey(state, { ...target, appId: undefined }), undefined);
  assert.equal(roomAgentThreadId("room", "member", "codex"), "room-agent-room-member-codex-v7");

  console.log("room-agent-runtime-fingerprint-harness ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
