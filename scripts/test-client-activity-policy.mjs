import assert from "node:assert/strict";
import {
  claimDailyClientActivityAttemptForKey,
  desktopClientActivityWindowIsForeground,
  desktopClientActivityReport,
  millisecondsUntilNextUtcDay,
  utcActivityDay,
} from "../web/src/runtime/client-activity-policy.ts";

class MemoryStorage {
  values = new Map();
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();
const morning = new Date("2026-08-05T00:00:00.000Z");
const storageKey = "opengroveClientActivityLastAttempt";
assert.equal(utcActivityDay(morning), "2026-08-05");
assert.equal(claimDailyClientActivityAttemptForKey(storage, storageKey, "user-1", morning), true);
assert.equal(
  claimDailyClientActivityAttemptForKey(storage, storageKey, "user-1", new Date("2026-08-05T23:59:59.000Z")),
  false,
);
assert.equal(claimDailyClientActivityAttemptForKey(storage, storageKey, "user-2", morning), true);
assert.equal(
  claimDailyClientActivityAttemptForKey(storage, storageKey, "user-1", new Date("2026-08-06T00:00:00.000Z")),
  true,
);
assert.equal(
  claimDailyClientActivityAttemptForKey(
    {
      getItem() {
        throw new Error("storage disabled");
      },
      setItem() {
        throw new Error("storage disabled");
      },
    },
    storageKey,
    "user-3",
    morning,
  ),
  false,
);
assert.equal(
  claimDailyClientActivityAttemptForKey(
    {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("storage disabled");
      },
    },
    storageKey,
    "user-4",
    morning,
  ),
  false,
);

assert.equal(
  desktopClientActivityWindowIsForeground({
    visibilityState: "visible",
    hasFocus: () => true,
  }),
  true,
);
assert.equal(
  desktopClientActivityWindowIsForeground({
    visibilityState: "visible",
    hasFocus: () => false,
  }),
  false,
);
assert.equal(
  desktopClientActivityWindowIsForeground({
    visibilityState: "hidden",
    hasFocus: () => true,
  }),
  false,
);

assert.deepEqual(
  desktopClientActivityReport({
    versions: { app: " 0.6.1 ", clientReleaseNumber: 560 },
  }),
  { clientVersion: "0.6.1", clientReleaseNumber: 560 },
);
assert.deepEqual(desktopClientActivityReport({ versions: { app: "0.6.1", clientReleaseNumber: 0 } }), {
  clientVersion: "0.6.1",
});
assert.equal(desktopClientActivityReport(undefined), undefined);
assert.equal(millisecondsUntilNextUtcDay(new Date("2026-08-05T23:59:59.500Z")), 1_500);

console.log("client-activity-policy ok");
