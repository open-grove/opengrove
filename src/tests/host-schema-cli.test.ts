import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHostOperationOverview, runHostOperationCommand } from "../cli/host-operation-command.js";

test("schema describes a command without connecting to a Host", async () => {
  const result = await runHostOperationCommand(["schema", "room.message.create"], {
    createClient: () => {
      throw new Error("Schema must not connect or load account credentials.");
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.exitCode, 0);
  const output = JSON.parse(result.stdout ?? "null");
  assert.equal(output.data.id, "room.message.create");
  assert.equal(output.data.command, "opengrove room message create");
  assert.equal(output.data.risk, "write");
  assert.equal(output.data.input.params.properties.roomId.type, "string");
  assert.equal(output.data.responses.success.status, 200);
});

test("schema navigation returns a compact domain list and rejects unknown paths", async () => {
  const domains = await runHostOperationCommand(["schema"]);
  assert.equal(domains.exitCode, 0);
  const output = JSON.parse(domains.stdout ?? "null");
  assert.ok(output.data.some((group: { id: string }) => group.id === "room"));
  const methods = await runHostOperationCommand(["schema", "app", "release"]);
  const methodOutput = JSON.parse(methods.stdout ?? "null");
  assert.ok(methodOutput.data.some((operation: { id: string }) => operation.id === "app.release.publish"));
  const unknown = await runHostOperationCommand(["schema", "app", "unknown"]);
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.stdout, undefined);
  assert.equal(JSON.parse(unknown.stderr ?? "null").error.subtype, "schema_not_found");
});

test("root help lists domains instead of dumping every operation", () => {
  const help = renderHostOperationOverview();
  assert.match(help, /room\s+Rooms/u);
  assert.doesNotMatch(help, /room message create/u);
});

test("Room collection commands omit repeated nouns while canonical operation paths remain usable", async () => {
  const concise = await runHostOperationCommand(["room", "create", "--title", "Concise", "--dry-run"]);
  const canonical = await runHostOperationCommand(["room", "room", "create", "--title", "Concise", "--dry-run"]);
  assert.equal(concise.handled, true);
  assert.equal(concise.exitCode, 0, concise.stderr);
  assert.deepEqual(JSON.parse(concise.stdout ?? "null"), JSON.parse(canonical.stdout ?? "null"));
  const schema = await runHostOperationCommand(["schema", "room", "create"]);
  assert.equal(schema.exitCode, 0, schema.stderr);
  assert.equal(JSON.parse(schema.stdout ?? "null").data.command, "opengrove room create");
  const help = await runHostOperationCommand(["room", "--help"]);
  assert.match(help.stdout ?? "", /create\s+Create a Room/u);
  assert.doesNotMatch(help.stdout ?? "", /room room/u);
  const unknown = await runHostOperationCommand(["room", "message", "unknown"]);
  assert.equal(unknown.exitCode, 2);
  assert.doesNotMatch(JSON.parse(unknown.stderr ?? "null").help, /auth|network/u);
});
