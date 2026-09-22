import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startOpenGroveServer } from "../server/create-server.js";
import { createSqliteStateStore } from "../storage/sqlite-state-store.js";
import type { PersistableAgentStatePorts } from "../storage/json-state-store.js";
import { resolveHostModules } from "../app/host-modules.js";

test("invalid module selections fail before opening state", () => {
  assert.throws(() => resolveHostModules(["routines"]), /requires_rooms/);
  assert.throws(() => resolveHostModules(["unknown"]), /unknown_host_module/);
});

for (const modules of [[], ["rooms"], ["rooms", "routines"]] as const) {
  test(`local composition ${modules.join(",") || "core"} gates routes, tools and product initialization`, async () => {
    const root = await mkdtemp(join(tmpdir(), "opengrove-modules-"));
    // A mount must remain in settings without triggering App filesystem inspection/migration.
    await writeFile(
      join(root, "bridge-settings.json"),
      JSON.stringify({ mountedApps: [{ id: "unused", path: join(root, "absent-app"), enabled: true }] }),
    );
    const store = createSqliteStateStore(join(root, "state.sqlite"));
    let app: PersistableAgentStatePorts | undefined;
    const server = startOpenGroveServer({
      modules: [...modules],
      profile: "test",
      host: "127.0.0.1",
      port: 0,
      bridgeToken: "test",
      store: {
        ...store,
        loadInto(value, options) {
          app = value;
          return store.loadInto(value, options);
        },
      },
    });
    try {
      if (!server.listening) await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const get = (path: string) => fetch(`${base}${path}`, { headers: { "x-opengrove-token": "test" } });
      const runtime = await get("/runtime");
      assert.equal(runtime.status, 200);
      assert.deepEqual((await runtime.json()).modules, {
        rooms: modules.length > 0,
        routines: modules.length > 1,
        apps: false,
      });
      assert.equal((await get("/rooms")).status, modules.length ? 200 : 404);
      assert.equal((await get("/routines")).status, modules.length > 1 ? 200 : 404);
      assert.equal((await get("/app-store")).status, 404);
      assert.equal((await get("/sessions")).status, 200);
      assert.ok(app);
      if (!modules.length) {
        assert.equal(app.rooms.snapshot().rooms.length, 0);
        assert.equal(app.rooms.snapshot().members.length, 0);
      }
      const inventory = await (await get("/inventory")).json();
      const ids = inventory.tools.map((tool: { id: string }) => tool.id);
      assert.equal(ids.includes("room.delegate.task"), modules.length > 0);
      assert.equal(ids.includes("workflow.create"), modules.length > 1);
      assert.equal(ids.includes("opengrove.app.import"), false);
      assert.equal(ids.includes("opengrove.app.command.run"), false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    }
  });
}
