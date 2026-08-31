import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "../core/stores/session-store.js";

test("session and run revisions follow their own record mutations", () => {
  const store = new SessionStore();
  const initial = store.revision();
  store.ensureSession({ id: "session-1", title: "First" });
  const sessionRevision = store.revision();
  assert.notEqual(sessionRevision, initial);

  store.startRun({
    id: "run-1",
    sessionId: "session-1",
    activity: "chat",
    input: "hello",
  });
  const runRevision = store.revision();
  assert.notEqual(runRevision, sessionRevision);
  assert.equal(store.revision(), runRevision);

  store.clear();
  assert.notEqual(store.revision(), runRevision);
});
