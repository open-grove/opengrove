import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const args = new Set(process.argv.slice(2));

if (args.has("--disabled-help")) {
  console.error("The browser UI bridge is not the default source workflow anymore.");
  console.error("Use `npm start` or `npm run desktop:dev` for the desktop shell.");
  console.error("Use `npm run bridge:web` only when you explicitly need http://127.0.0.1:37371/ui/.");
  process.exit(1);
}

const buildInvocation = nodePackageManagerInvocation("npm", ["run", "build"]);
run(buildInvocation.command, buildInvocation.args);

const bridgeEntry = resolve(projectRoot, "dist", "server", "local-bridge.js");
if (!existsSync(bridgeEntry)) {
  console.error("dist/server/local-bridge.js is missing. Run `npm run build:server` first.");
  process.exit(1);
}

run(process.execPath, [bridgeEntry], {
  env: {
    ...process.env,
    OPENGROVE_ENABLE_BROWSER_UI: "1",
  },
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
}
