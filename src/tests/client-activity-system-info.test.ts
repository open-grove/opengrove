import assert from "node:assert/strict";
import { test } from "node:test";
import { readClientActivitySystemInfo } from "../server/client-activity-system-info.js";

test("activity preserves OS-provided release and version descriptions", () => {
  assert.deepEqual(readClientActivitySystemInfo({ release: () => "10.0.16299", version: () => "Windows 10 Pro" }), {
    operatingSystemRelease: "10.0.16299",
    operatingSystemVersion: "Windows 10 Pro",
  });
  assert.deepEqual(readClientActivitySystemInfo({ release: () => "10.0.26100", version: () => "Windows 11 Pro" }), {
    operatingSystemRelease: "10.0.26100",
    operatingSystemVersion: "Windows 11 Pro",
  });
  assert.deepEqual(
    readClientActivitySystemInfo({
      release: () => " 6.8.0-60-generic ",
      version: () => "#63-Ubuntu SMP PREEMPT_DYNAMIC",
    }),
    {
      operatingSystemRelease: "6.8.0-60-generic",
      operatingSystemVersion: "#63-Ubuntu SMP PREEMPT_DYNAMIC",
    },
  );
});

test("unsupported system details are omitted without truncation or losing other metadata", () => {
  for (const invalid of ["", " ", "build\n123", "build\u007f123", "build\u0085123", "a".repeat(129)]) {
    assert.deepEqual(readClientActivitySystemInfo({ release: () => invalid, version: () => "Windows 10 Pro" }), {
      operatingSystemRelease: undefined,
      operatingSystemVersion: "Windows 10 Pro",
    });
  }
  assert.deepEqual(readClientActivitySystemInfo({ release: () => "10.0.16299", version: () => "a".repeat(257) }), {
    operatingSystemRelease: "10.0.16299",
    operatingSystemVersion: undefined,
  });
});
