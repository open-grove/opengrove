import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appReadinessReportPath, notifyPmOfAppReadiness, writeAppReadinessReport } from "../server/app-readiness.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { defaultAppGroupRoomId } from "../server/app-room-ids.js";
import { pmAgentMemberId } from "../server/bridge-mounted-app-employees.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-readiness-"));
let store: ReturnType<typeof createBridgeState>["store"] | undefined;
const previousSecretsDir = process.env.OPENGROVE_APP_SECRETS_DIR;
const previousEnvValue = process.env.READINESS_PRESENT_ENV;

try {
  process.env.OPENGROVE_APP_SECRETS_DIR = join(tempRoot, "secrets");
  process.env.READINESS_PRESENT_ENV = "present";
  mkdirSync(process.env.OPENGROVE_APP_SECRETS_DIR, { recursive: true });
  writeFileSync(
    join(process.env.OPENGROVE_APP_SECRETS_DIR, "readiness-demo.env"),
    "READINESS_SECRET_ENV=secret\n",
    "utf8",
  );

  const appRoot = join(tempRoot, "readiness-demo");
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  mkdirSync(join(appRoot, ".env.local"), { recursive: true });
  mkdirSync(join(appRoot, "skills", "auto-material", "bgm"), { recursive: true });
  writeFileSync(join(appRoot, "requirements.txt"), "pydantic\n", "utf8");
  writeFileSync(join(appRoot, "skills", "auto-material", "bgm", "one.mp3"), "one", "utf8");
  writeFileSync(join(appRoot, "skills", "auto-material", "bgm", "two.wav"), "two", "utf8");
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "readiness-demo",
        title: "Readiness Demo",
        version: "0.1.0",
        workspace: { path: "workspace" },
        store: {
          requirements: {
            system: ["node", "opengrove-definitely-missing-tool"],
            env: ["READINESS_PRESENT_ENV", "READINESS_SECRET_ENV", "READINESS_MISSING_ENV"],
            runtimes: [
              {
                id: "python",
                version: ">=3.10",
                manager: "uv",
                requirements: ["requirements.txt"],
              },
            ],
          },
        },
        assets: [
          {
            id: "bgm",
            title: "BGM 曲库",
            kind: "directory",
            required: true,
            accept: [".mp3", ".wav"],
            preferredMountPath: "skills/auto-material/bgm",
            validation: { minFiles: 2 },
          },
        ],
        employees: [
          {
            id: "operator",
            name: "Operator",
            role: "Runs readiness checks.",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const state = createBridgeState({ statePath: join(tempRoot, "state.json") });
  store = state.store;
  state.settings.languagePreference = "zh-CN";
  state.settings.mountedApps = [
    {
      id: "readiness-demo",
      path: appRoot,
      title: "Readiness Demo",
      enabled: true,
    },
  ];
  recreateBridgeApp(state);

  const report = writeAppReadinessReport(state, "readiness-demo");
  assert.equal(report.appId, "readiness-demo");
  assert.equal(report.status, "needs_setup");
  assert.equal(existsSync(appReadinessReportPath(state, "readiness-demo")), true);

  const itemById = new Map(report.items.map((item) => [item.id, item]));
  assert.equal(itemById.get("system:node")?.status, "ok");
  assert.equal(itemById.get("system:opengrove-definitely-missing-tool")?.status, "missing");
  assert.equal(itemById.get("READINESS_PRESENT_ENV")?.status, "ok");
  assert.equal(itemById.get("READINESS_SECRET_ENV")?.status, "ok");
  assert.equal(itemById.get("READINESS_MISSING_ENV")?.status, "missing");
  assert.equal(itemById.get("runtime:python")?.status, "installable");
  assert.deepEqual(itemById.get("runtime:python")?.fix?.sideEffects, ["local-write", "network-read"]);
  assert.equal(itemById.get("bgm")?.status, "ok");

  const stored = JSON.parse(readFileSync(appReadinessReportPath(state, "readiness-demo"), "utf8")) as typeof report;
  assert.equal(
    stored.items.some((item) => item.kind === "asset" && item.id === "bgm"),
    true,
  );

  assert.equal(notifyPmOfAppReadiness(state, report), true);
  const roomId = defaultAppGroupRoomId("readiness-demo");
  const messages = state.app.rooms.listMessages(roomId, { limit: 20 });
  const pmId = pmAgentMemberId("readiness-demo");
  const pmMessage = messages.find((message) => message.senderId === pmId && message.text.includes("还没完全就绪"));
  assert.ok(pmMessage, "readiness notifier should post PM handoff message");
  assert.match(pmMessage.text, /READINESS_MISSING_ENV/);

  const storySeedRoot = join(tempRoot, "story-seed");
  mkdirSync(join(storySeedRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(storySeedRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "story-seed",
        title: "故事种子",
        defaultLocale: "zh-CN",
        version: "0.2.21",
        welcome: {
          message: "我是故事种子 PM。故事架构师负责共创，金牌编辑负责审核，首席运营官负责上传。",
        },
        locales: {
          en: {
            title: "Story Seed",
            welcome: {
              message:
                "I am the Story Seed PM. The Story Architect co-creates, the Editor reviews, and the COO uploads.",
            },
          },
        },
        workspace: { path: "workspace" },
        employees: [
          {
            id: "writer",
            name: "故事架构师",
            role: "共创故事大纲。",
          },
          {
            id: "editor",
            name: "金牌编辑",
            role: "独立审核并完成审核后的运营闭环。",
            defaultSkillIds: ["story-review", "story-ops"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  state.settings.mountedApps.push({
    id: "story-seed",
    path: storySeedRoot,
    title: "故事种子",
    enabled: true,
  });
  state.settings.languagePreference = "en";
  recreateBridgeApp(state);

  const storySeedReport = writeAppReadinessReport(state, "story-seed");
  assert.equal(storySeedReport.status, "ready");
  assert.equal(storySeedReport.title, "Story Seed");
  assert.equal(notifyPmOfAppReadiness(state, storySeedReport), true);
  const storySeedMessages = state.app.rooms.listMessages(defaultAppGroupRoomId("story-seed"), { limit: 20 });
  const storySeedIntro = storySeedMessages.find(
    (message) => message.senderId === pmAgentMemberId("story-seed") && message.text.includes("I am the Story Seed PM"),
  );
  assert.ok(storySeedIntro, "Manifest welcome should follow the user's language preference");
  assert.match(storySeedIntro.text, /Story Architect.*Editor.*COO/);

  state.settings.languagePreference = "zh-CN";
  assert.equal(notifyPmOfAppReadiness(state, storySeedReport), true);
  const localizedStorySeedMessages = state.app.rooms.listMessages(defaultAppGroupRoomId("story-seed"), { limit: 30 });
  const localizedStorySeedIntros = localizedStorySeedMessages.filter(
    (message) => message.senderId === pmAgentMemberId("story-seed") && message.text.includes("我是故事种子 PM"),
  );
  assert.equal(
    localizedStorySeedIntros.length,
    1,
    "A welcome marker from another locale must not suppress the current locale",
  );
  assert.equal(notifyPmOfAppReadiness(state, storySeedReport), true);
  const repeatedLocalizedStorySeedMessages = state.app.rooms.listMessages(defaultAppGroupRoomId("story-seed"), {
    limit: 40,
  });
  assert.equal(
    repeatedLocalizedStorySeedMessages.filter(
      (message) => message.senderId === pmAgentMemberId("story-seed") && message.text.includes("我是故事种子 PM"),
    ).length,
    1,
    "The same app version and locale should post its welcome only once",
  );
  state.settings.languagePreference = "en";
  assert.equal(notifyPmOfAppReadiness(state, storySeedReport), true);
  const returnedEnglishStorySeedMessages = state.app.rooms.listMessages(defaultAppGroupRoomId("story-seed"), {
    limit: 50,
  });
  assert.equal(
    returnedEnglishStorySeedMessages.filter(
      (message) =>
        message.senderId === pmAgentMemberId("story-seed") && message.text.includes("I am the Story Seed PM"),
    ).length,
    1,
    "Returning to a locale already posted for this app version must not duplicate its welcome",
  );

  const legacyMarkerPath = join(tempRoot, "app-readiness", "story-seed.pm-intro.json");
  writeFileSync(
    legacyMarkerPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        appId: "story-seed",
        version: "0.2.21",
        sentAt: "2026-07-07T11:30:32.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  state.settings.languagePreference = "zh-CN";
  assert.equal(notifyPmOfAppReadiness(state, storySeedReport), true);
  const messagesAfterLegacyMigration = state.app.rooms.listMessages(defaultAppGroupRoomId("story-seed"), { limit: 60 });
  assert.equal(
    messagesAfterLegacyMigration.filter(
      (message) => message.senderId === pmAgentMemberId("story-seed") && message.text.includes("我是故事种子 PM"),
    ).length,
    1,
    "A v1 marker should migrate without duplicating the welcome in the current locale",
  );
  const migratedLegacyMarker = JSON.parse(readFileSync(legacyMarkerPath, "utf8")) as {
    schemaVersion?: number;
    locales?: string[];
  };
  assert.equal(migratedLegacyMarker.schemaVersion, 2);
  assert.deepEqual(migratedLegacyMarker.locales, ["zh-CN"]);

  state.settings.languagePreference = "en";
  assert.equal(notifyPmOfAppReadiness(state, storySeedReport), true);
  const messagesAfterMigratedLocaleChange = state.app.rooms.listMessages(defaultAppGroupRoomId("story-seed"), {
    limit: 70,
  });
  assert.equal(
    messagesAfterMigratedLocaleChange.filter(
      (message) =>
        message.senderId === pmAgentMemberId("story-seed") && message.text.includes("I am the Story Seed PM"),
    ).length,
    2,
    "A persisted v1 migration must still allow a later locale to receive its welcome",
  );

  console.log("app-readiness-harness ok");
} finally {
  if (previousSecretsDir === undefined) {
    delete process.env.OPENGROVE_APP_SECRETS_DIR;
  } else {
    process.env.OPENGROVE_APP_SECRETS_DIR = previousSecretsDir;
  }
  if (previousEnvValue === undefined) {
    delete process.env.READINESS_PRESENT_ENV;
  } else {
    process.env.READINESS_PRESENT_ENV = previousEnvValue;
  }
  await store?.close?.();
  rmSync(tempRoot, { recursive: true, force: true });
}
