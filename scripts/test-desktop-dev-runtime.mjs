import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  desktopDevBootstrapSource,
  desktopDevExecutableLauncherSource,
  desktopDevProfileEnvironment,
  desktopDevRestartArgumentsFromEnvironment,
  desktopDevOpenEnvironmentArguments,
  resolveDesktopDevProfileOptions,
  desktopDevRuntimePaths,
  DEV_APP_NAME,
  DEV_URL_SCHEME,
  isLegacyDesktopDevAppPath,
  legacyDesktopDevAppPath,
  parseLaunchServicesDevAppPaths,
  selectDesktopDevProject,
  verifyDesktopDevProfileProbe,
} from "./desktop-dev-runtime.mjs";

const fakeHome = resolve("Users", "developer");
assert.equal(DEV_URL_SCHEME, "opengrove-dev");
const firstProject = resolve("workspace", "first-opengrove");
const secondProject = resolve("workspace", "second-opengrove");
const firstRuntime = desktopDevRuntimePaths({ homeDir: fakeHome });
const secondRuntime = desktopDevRuntimePaths({ homeDir: fakeHome });

assert.equal(firstRuntime.appPath, secondRuntime.appPath, "all worktrees must resolve to the same user-level Dev app");

assert.equal(
  resolveDesktopDevProfileOptions([], {
    homeDir: fakeHome,
    platform: "darwin",
    env: {},
  }),
  undefined,
);
const testProfile = resolveDesktopDevProfileOptions(
  [
    "--profile",
    "test",
    "--ww-base-url=https://ww-test.example.test/",
    "--release-control-url=https://release-control-test.example.test/app-release-api/",
  ],
  {
    homeDir: fakeHome,
    platform: "darwin",
    env: {},
  },
);
assert.deepEqual(testProfile, {
  name: "test",
  wwBaseUrl: "https://ww-test.example.test",
  releaseControlUrl: "https://release-control-test.example.test/app-release-api",
  userDataDir: join(fakeHome, "Library", "Application Support", "OpenGroveDev-test"),
  environmentOverrides: {
    OPENGROVE_DESKTOP_DEV_PROFILE: "test",
    OPENGROVE_DESKTOP_DEV_USER_DATA_DIR: join(fakeHome, "Library", "Application Support", "OpenGroveDev-test"),
    OPENGROVE_WW_BASE_URL: "https://ww-test.example.test",
    OPENGROVE_WW_API_KEY: "",
    OPENGROVE_WW_ACCESS_TOKEN: "",
    OPENGROVE_WW_USER_ID: "",
    OPENGROVE_WW_USER_EMAIL: "",
    OPENGROVE_RELEASE_CONTROL_URL: "https://release-control-test.example.test/app-release-api",
    OPENGROVE_APP_STORE_REGISTRY_URL: "https://release-control-test.example.test/app-release-api",
    OPENGROVE_APP_STORE_REGISTRY_TOKEN: "",
    APP_STORE_REGISTRY_URL: "",
    APP_STORE_REGISTRY_TOKEN: "",
  },
});
const environmentTestProfile = resolveDesktopDevProfileOptions(["--profile", "test"], {
  homeDir: fakeHome,
  platform: "darwin",
  env: {
    OPENGROVE_DESKTOP_DEV_TEST_WW_BASE_URL: "https://ww-test.example.test/",
    OPENGROVE_DESKTOP_DEV_TEST_RELEASE_CONTROL_URL: "https://release-control-test.example.test/app-release-api/",
  },
});
assert.deepEqual(
  environmentTestProfile,
  testProfile,
  "a named desktop profile may load its service URLs from local environment configuration",
);
assert.doesNotThrow(() =>
  verifyDesktopDevProfileProbe(testProfile, {
    desktopDevProfile: {
      name: "test",
      appStoreRegistryUrl: "https://release-control-test.example.test/app-release-api",
      releaseControlUrl: "https://release-control-test.example.test/app-release-api",
    },
  }),
);
assert.throws(
  () =>
    verifyDesktopDevProfileProbe(testProfile, {
      desktopDevProfile: {
        name: "test",
        appStoreRegistryUrl: "https://release-control-test.example.test/app-release-api",
      },
    }),
  /resolved Release Control missing/u,
  "profile verification must use the live Bridge probe instead of persisted settings",
);
assert.throws(
  () =>
    verifyDesktopDevProfileProbe(testProfile, {
      desktopDevProfile: {
        name: "production",
        appStoreRegistryUrl: "https://release-control-test.example.test/app-release-api",
        releaseControlUrl: "https://release-control-test.example.test/app-release-api",
      },
    }),
  /resolved live profile production/u,
  "profile verification must reject a live Bridge from another desktop profile",
);
const isolatedProfileEnvironment = desktopDevProfileEnvironment(
  {
    PATH: "/usr/bin",
    OPENGROVE_DESKTOP_DEV_RUNTIME_ROOT: "/tmp/opengrove-dev-runtime",
    OPENGROVE_DESKTOP_DEV_TEST_WW_BASE_URL: "https://private-ww.example.test",
    OPENGROVE_DESKTOP_DEV_TEST_RELEASE_CONTROL_URL: "https://private-release-control.example.test",
    OPENGROVE_WW_BASE_URL: "https://ww-production.example.test",
    OPENGROVE_WW_API_KEY: "production-api-key",
    OPENGROVE_RELEASE_CONTROL_URL: "https://release-control-production.example.test",
    OPENGROVE_APP_STORE_REGISTRY_URL: "https://ww-production.example.test",
    OPENGROVE_APP_STORE_REGISTRY_TOKEN: "production-registry-token",
    APP_STORE_REGISTRY_URL: "https://legacy-production.example",
    APP_STORE_REGISTRY_TOKEN: "legacy-production-registry-token",
  },
  testProfile,
);
assert.equal(isolatedProfileEnvironment.PATH, "/usr/bin");
assert.equal(isolatedProfileEnvironment.OPENGROVE_DESKTOP_DEV_RUNTIME_ROOT, "/tmp/opengrove-dev-runtime");
assert.equal(isolatedProfileEnvironment.OPENGROVE_DESKTOP_DEV_TEST_WW_BASE_URL, undefined);
assert.equal(isolatedProfileEnvironment.OPENGROVE_DESKTOP_DEV_TEST_RELEASE_CONTROL_URL, undefined);
assert.equal(isolatedProfileEnvironment.OPENGROVE_WW_BASE_URL, testProfile.wwBaseUrl);
assert.equal(isolatedProfileEnvironment.OPENGROVE_WW_API_KEY, "");
assert.equal(isolatedProfileEnvironment.OPENGROVE_RELEASE_CONTROL_URL, testProfile.releaseControlUrl);
assert.equal(isolatedProfileEnvironment.OPENGROVE_APP_STORE_REGISTRY_URL, testProfile.releaseControlUrl);
assert.equal(isolatedProfileEnvironment.OPENGROVE_APP_STORE_REGISTRY_TOKEN, "");
assert.equal(isolatedProfileEnvironment.APP_STORE_REGISTRY_URL, "");
assert.equal(isolatedProfileEnvironment.APP_STORE_REGISTRY_TOKEN, "");
assert.deepEqual(
  desktopDevRestartArgumentsFromEnvironment(isolatedProfileEnvironment),
  [
    "scripts/restart-desktop-dev.mjs",
    "--skip-build",
    "--profile",
    "test",
    "--ww-base-url",
    testProfile.wwBaseUrl,
    "--release-control-url",
    testProfile.releaseControlUrl,
  ],
  "a source update must restart only the profile that initiated it",
);
assert.throws(
  () =>
    desktopDevRestartArgumentsFromEnvironment({
      OPENGROVE_DESKTOP_DEV_PROFILE: "test",
    }),
  /desktop_dev_profile_restart_config_incomplete/u,
  "profiled source updates must fail closed instead of restarting the default profile",
);
assert.deepEqual(
  desktopDevOpenEnvironmentArguments({
    OPENGROVE_WW_BASE_URL: "https://ww.example.test",
    OPENGROVE_DESKTOP_DEV_PROFILE: "test",
  }),
  ["--env", "OPENGROVE_DESKTOP_DEV_PROFILE=test", "--env", "OPENGROVE_WW_BASE_URL=https://ww.example.test"],
  "macOS LaunchServices must receive profile overrides explicitly",
);
assert.throws(
  () =>
    resolveDesktopDevProfileOptions(["--profile=test"], {
      homeDir: fakeHome,
      platform: "darwin",
      env: {},
    }),
  /--ww-base-url/,
);
assert.throws(
  () =>
    resolveDesktopDevProfileOptions(["--profile=test", "--ww-base-url=https://ww-test.example.test"], {
      homeDir: fakeHome,
      platform: "darwin",
      env: {},
    }),
  /--release-control-url/,
);
assert.throws(
  () =>
    resolveDesktopDevProfileOptions(
      [
        "--profile=../production",
        "--ww-base-url=https://ww-test.example.test",
        "--release-control-url=https://release-control-test.example.test/app-release-api",
      ],
      {
        homeDir: fakeHome,
        platform: "darwin",
        env: {},
      },
    ),
  /profile/,
);
assert.equal(firstRuntime.executablePath.endsWith(join("Contents", "MacOS", "OpenGroveDev")), true);
assert.equal(firstRuntime.userDataPath, join(fakeHome, "Library", "Application Support", "OpenGroveDev"));
assert.equal(
  firstRuntime.appPath,
  join(fakeHome, "Library", "Application Support", "OpenGroveDev", "runtime", "electron", `${DEV_APP_NAME}.app`),
);

const firstLegacyApp = legacyDesktopDevAppPath(firstProject);
const secondLegacyApp = legacyDesktopDevAppPath(secondProject);
assert.notEqual(firstLegacyApp, secondLegacyApp);
assert.equal(isLegacyDesktopDevAppPath(firstLegacyApp, firstRuntime.appPath), true);
assert.equal(isLegacyDesktopDevAppPath(firstRuntime.appPath, firstRuntime.appPath), false);

const launchServicesDump = `
path:                       ${firstLegacyApp} (0xab84)
name:                       OpenGrove Dev
identifier:                 cn.opengrove.desktop.dev
path:                       /Applications/OpenGrove.app (0xab85)
name:                       OpenGrove
identifier:                 cn.opengrove.desktop
path:                       ${secondLegacyApp} (0xab86)
name:                       OpenGrove Dev
identifier:                 cn.opengrove.desktop.dev
`;
assert.deepEqual(
  parseLaunchServicesDevAppPaths(launchServicesDump),
  [firstLegacyApp, secondLegacyApp],
  "only Dev app registrations should be returned",
);
assert.deepEqual(
  parseLaunchServicesDevAppPaths(`
path:                       ${firstLegacyApp} (0xab87)
identifier:                 cn.opengrove.desktop
identifier:                 cn.opengrove.desktop.dev
`),
  [],
  "a path from the previous registration must not leak into the next identifier",
);

const activeProject = { projectRoot: secondProject };
const validationCalls = [];
const validateProject = (candidate) => {
  validationCalls.push(candidate);
  return candidate === secondProject ? activeProject : undefined;
};
assert.equal(
  selectDesktopDevProject(firstProject, secondProject, validateProject),
  undefined,
  "an invalid explicit project must not fall back to the active project",
);
assert.deepEqual(
  validationCalls,
  [firstProject],
  "the active project must not be inspected when an explicit project was provided",
);
validationCalls.length = 0;
assert.equal(
  selectDesktopDevProject(undefined, secondProject, validateProject),
  activeProject,
  "the active project should be used only when no explicit project was provided",
);
assert.deepEqual(validationCalls, [secondProject]);
validationCalls.length = 0;
assert.equal(
  selectDesktopDevProject(undefined, "", validateProject),
  undefined,
  "a missing active project must not resolve the bootstrap working directory",
);
assert.deepEqual(validationCalls, [""]);

const bootstrap = desktopDevBootstrapSource(firstRuntime.activeProjectPath);
assert.match(bootstrap, /desktop-dist\/main\.cjs/u);
assert.match(bootstrap, /selectDesktopDevProject/u);
assert.match(bootstrap, /app\.setAppPath\(project\.projectRoot\)/u);
assert.match(bootstrap, /import\(pathToFileURL\(project\.desktopEntry\)\.toString\(\)\)/u);
assert.match(bootstrap, /dialog\.showErrorBox/u);
assert.doesNotMatch(bootstrap, /app\.relaunch/u);
assert.doesNotMatch(bootstrap, /appendSwitch\("use-mock-keychain"\)/u);
assert.doesNotMatch(bootstrap, /BrowserWindow/u);

const executableLauncher = desktopDevExecutableLauncherSource();
assert.match(executableLauncher, /--use-mock-keychain/u);
assert.match(executableLauncher, /exec "\$\{launcher_dir\}\/Electron"/u);

process.stdout.write("desktop-dev runtime: ok\n");
