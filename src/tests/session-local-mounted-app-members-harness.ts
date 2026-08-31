import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalBridgeServer } from "../server/local-bridge.js";

const dir = mkdtempSync(join(tmpdir(), "opengrove-local-session-mounted-app-"));
const previousWwBaseUrl = process.env.OPENGROVE_WW_BASE_URL;
const previousWebAuthMode = process.env.OPENGROVE_WEB_AUTH_MODE;

const fakeWw = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/v1/users/me") {
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token !== "valid-local") {
      sendJson(response, 401, { error: { code: 110201, message: "access invalid" } });
      return;
    }
    sendJson(response, 200, {
      data: { user_id: "local_session_user", email: "local-session@example.test", role: "user" },
      request_id: "test",
    });
    return;
  }
  sendJson(response, 404, { error: { code: 404, message: "not found" } });
});

try {
  fakeWw.listen(0, "127.0.0.1");
  await once(fakeWw, "listening");
  const fakeWwAddress = fakeWw.address() as AddressInfo;
  process.env.OPENGROVE_WW_BASE_URL = `http://127.0.0.1:${fakeWwAddress.port}`;
  process.env.OPENGROVE_WEB_AUTH_MODE = "session";

  const appRoot = join(dir, "session-local-app");
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify({
      id: "session-local-app",
      title: "Session Local App",
      disablePmAgent: true,
      employees: [
        {
          id: "local-worker",
          name: "Local Worker",
          kernel: "codex",
          role: "Local mounted app worker.",
        },
      ],
    })}\n`,
    "utf8",
  );
  const emptyNoPmAppRoot = join(dir, "empty-no-pm-app");
  mkdirSync(emptyNoPmAppRoot, { recursive: true });
  writeFileSync(
    join(emptyNoPmAppRoot, "opengrove.app.json"),
    `${JSON.stringify({
      id: "empty-no-pm-app",
      title: "Empty No PM App",
      disablePmAgent: true,
      employees: [],
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "bridge-settings.json"),
    `${JSON.stringify({
      kernel: "claude-code",
      mountedApps: [
        { id: "session-local-app", path: appRoot, enabled: true },
        { id: "empty-no-pm-app", path: emptyNoPmAppRoot, enabled: true },
      ],
    })}\n`,
    "utf8",
  );
  const statePath = join(dir, "state.json");
  const scopedLegacyMemberId = "member-user-9f86d081884c-member-legacy-codex";
  const scopedLegacyRoomId = "cloud-user:local_session_user:direct-member-legacy-codex";
  const scopedMountedAppMemberId = "member-user-9f86d081884c-member-app-session-local-app-local-worker";
  const stableMountedAppMemberId = "member-app-session-local-app-local%2Dworker";
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        version: 9,
        savedAt: new Date().toISOString(),
        routines: [
          {
            id: "routine-scoped-local",
            title: "Scoped local routine",
            status: "active",
            trigger: "manual",
            capabilityIds: [],
            approvalRules: [],
            steps: [
              {
                id: "step-scoped-local",
                title: "Run mounted app worker",
                memberId: scopedMountedAppMemberId,
                roomId: "cloud-user:local_session_user:app-room--session-local-app--group--default",
                prompt: "work",
              },
            ],
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
        ],
        rooms: {
          version: 1,
          currentEventSeq: 3,
          rooms: [
            {
              id: scopedLegacyRoomId,
              kind: "direct",
              title: "Legacy Codex",
              badge: "DM",
              memberIds: [scopedLegacyMemberId],
              directMemberId: scopedLegacyMemberId,
              updatedAt: "2026-06-01T00:00:02.000Z",
              unread: 0,
            },
          ],
          members: [
            {
              id: scopedLegacyMemberId,
              name: "Legacy Codex",
              kernel: "codex",
              model: "gpt-5.5",
              role: "Legacy local employee.",
              status: "idle",
              color: "#2563eb",
              lastActive: "在线",
              source: "local",
            },
          ],
          messages: [
            {
              id: "message-legacy-user",
              roomId: scopedLegacyRoomId,
              channelSeq: 1,
              senderId: "user",
              senderName: "You",
              senderType: "user",
              text: "old local hello",
              targetIds: [scopedLegacyMemberId],
              status: "sent",
              createdAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
            {
              id: "message-legacy-agent",
              roomId: scopedLegacyRoomId,
              channelSeq: 2,
              senderId: scopedLegacyMemberId,
              senderName: "Legacy Codex",
              senderType: "agent",
              text: "old local answer",
              targetIds: [],
              status: "done",
              createdAt: "2026-06-01T00:00:01.000Z",
              updatedAt: "2026-06-01T00:00:01.000Z",
            },
          ],
          events: [],
          deletedMemberIds: [],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const server = startLocalBridgeServer({
    host: "127.0.0.1",
    port: 0,
    statePath,
  });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      cookie:
        "opengrove_auth_access=valid-local; opengrove_auth_refresh=refresh-local; opengrove_auth_session=valid-local",
    };
    const init = await getJson(`${baseUrl}/api/rooms?limit=20`, { headers });
    const mountedAppMember = (init.members as Array<{ id?: string; appId?: string }> | undefined)?.find(
      (member) => member.appId === "session-local-app",
    );
    const mountedAppMemberId = mountedAppMember?.id ?? "";
    assert.equal(mountedAppMemberId, stableMountedAppMemberId);
    assert.equal(
      (init.members as Array<{ appId?: string }> | undefined)?.some((member) => member.appId === "empty-no-pm-app"),
      false,
      "an enabled App with no Employees and PM disabled must not crash cold startup",
    );
    assert.equal(JSON.stringify(init).includes("cloud-user:"), false);
    assert.equal(JSON.stringify(init).includes("member-user-"), false);
    const legacyMember = (init.members as Array<{ id?: string; name?: string }> | undefined)?.find(
      (member) => member.name === "Legacy Codex",
    );
    assert.equal(legacyMember?.id, "member-legacy-codex");
    const defaultAppRoom = (
      init.rooms as
        | Array<{
            id?: string;
            memberIds?: string[];
            adminMemberIds?: string[];
            scope?: { kind?: string; appId?: string; role?: string };
          }>
        | undefined
    )?.find((room) => room.id === "app-room--session-local-app--group--default");
    assert.deepEqual(defaultAppRoom?.memberIds, [mountedAppMemberId]);
    assert.deepEqual(defaultAppRoom?.adminMemberIds, []);
    assert.deepEqual(defaultAppRoom?.scope, {
      kind: "app",
      appId: "session-local-app",
      role: "default",
    });
    const legacyRoom = (
      init.rooms as Array<{ id?: string; directMemberId?: string; memberIds?: string[] }> | undefined
    )?.find((room) => room.id === "direct-member-legacy-codex");
    assert.equal(legacyRoom?.directMemberId, legacyMember?.id);
    assert.deepEqual(legacyRoom?.memberIds, [legacyMember?.id]);
    const legacyMessages =
      (
        init.messages as
          | Array<{ id?: string; roomId?: string; senderId?: string; targetIds?: string[]; text?: string }>
          | undefined
      )?.filter((message) => message.roomId === "direct-member-legacy-codex") ?? [];
    assert.equal(legacyMessages.length, 2);
    assert.deepEqual(legacyMessages.find((message) => message.id === "message-legacy-user")?.targetIds, [
      legacyMember?.id,
    ]);
    assert.equal(legacyMessages.find((message) => message.id === "message-legacy-agent")?.senderId, legacyMember?.id);

    const room = await postJson(
      `${baseUrl}/api/rooms`,
      {
        id: "app-room--session-local-app--group--default",
        title: "Session Local App 群组",
        memberIds: [mountedAppMemberId],
        scope: { kind: "app", appId: "session-local-app", role: "default" },
      },
      headers,
    );
    const createdRoom = room.room as { id?: string; memberIds?: string[] } | undefined;
    assert.equal(createdRoom?.memberIds?.includes(mountedAppMemberId), true);
    assert.equal(createdRoom?.id, "app-room--session-local-app--group--default");

    await closeServer(server);
    const restarted = startLocalBridgeServer({ host: "127.0.0.1", port: 0, statePath });
    try {
      if (!restarted.listening) await once(restarted, "listening");
      const restartedAddress = restarted.address() as AddressInfo;
      const restartedBaseUrl = `http://127.0.0.1:${restartedAddress.port}`;
      const persistedRooms = await getJson(`${restartedBaseUrl}/api/rooms?limit=20`, { headers });
      const persistedRoutines = await getJson(`${restartedBaseUrl}/api/routines`, { headers });
      const storedRooms = (persistedRooms.rooms as Array<{ id?: string }> | undefined) ?? [];
      const storedMessages = (persistedRooms.messages as Array<{ roomId?: string }> | undefined) ?? [];
      const routines =
        (persistedRoutines.routines as Array<{ steps?: Array<{ memberId?: string; roomId?: string }> }> | undefined) ??
        [];
      assert.equal(
        storedRooms.some((item) => item.id === "direct-member-legacy-codex"),
        true,
      );
      assert.equal(
        storedMessages.some((item) => item.roomId === "direct-member-legacy-codex"),
        true,
      );
      assert.equal(
        storedRooms.some((item) => item.id === scopedLegacyRoomId),
        false,
      );
      assert.equal(JSON.stringify({ persistedRooms, persistedRoutines }).includes("cloud-user:"), false);
      assert.equal(JSON.stringify({ persistedRooms, persistedRoutines }).includes("member-user-"), false);
      assert.equal(routines[0]?.steps?.[0]?.memberId, stableMountedAppMemberId);
      assert.equal(routines[0]?.steps?.[0]?.roomId, "app-room--session-local-app--group--default");
      assert.equal(existsSync(join(dir, "state.sqlite.before-unscoped-migration.json")), true);
    } finally {
      await closeServer(restarted);
    }
  } finally {
    if (server.listening) await closeServer(server);
  }

  console.log("session-local-mounted-app-members-harness ok");
} finally {
  await new Promise<void>((resolve) => fakeWw.close(() => resolve()));
  if (previousWwBaseUrl === undefined) {
    delete process.env.OPENGROVE_WW_BASE_URL;
  } else {
    process.env.OPENGROVE_WW_BASE_URL = previousWwBaseUrl;
  }
  if (previousWebAuthMode === undefined) {
    delete process.env.OPENGROVE_WEB_AUTH_MODE;
  } else {
    process.env.OPENGROVE_WEB_AUTH_MODE = previousWebAuthMode;
  }
  rmSync(dir, { recursive: true, force: true });
}

async function closeServer(server: ReturnType<typeof startLocalBridgeServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson(url: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, options);
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}
