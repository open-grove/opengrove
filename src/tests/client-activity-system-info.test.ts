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

test("activity preserves localized system descriptions", () => {
  for (const description of ["Windows 11 专业版", "Windows 11 プロ", "Windows 11 Профессиональная"]) {
    assert.deepEqual(readClientActivitySystemInfo({ release: () => "10.0.26100", version: () => description }), {
      operatingSystemRelease: "10.0.26100",
      operatingSystemVersion: description,
    });
  }
  assert.deepEqual(
    readClientActivitySystemInfo({ release: () => " 6.8.0-国产 ", version: () => " Windows 11 专业版 " }),
    {
      operatingSystemRelease: "6.8.0-国产",
      operatingSystemVersion: "Windows 11 专业版",
    },
  );
});

test("system details retain values at the length limits and omit longer values", () => {
  const releaseAtLimit = "版".repeat(128);
  const versionAtLimit = "版".repeat(256);
  assert.deepEqual(readClientActivitySystemInfo({ release: () => releaseAtLimit, version: () => versionAtLimit }), {
    operatingSystemRelease: releaseAtLimit,
    operatingSystemVersion: versionAtLimit,
  });
  assert.deepEqual(
    readClientActivitySystemInfo({ release: () => `${releaseAtLimit}本`, version: () => `${versionAtLimit}本` }),
    { operatingSystemRelease: undefined, operatingSystemVersion: undefined },
  );
});

test("system details omit embedded controls and line separators in either field", () => {
  for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029]) {
    const invalid = `build${String.fromCharCode(code)}123`;
    assert.deepEqual(readClientActivitySystemInfo({ release: () => invalid, version: () => invalid }), {
      operatingSystemRelease: undefined,
      operatingSystemVersion: undefined,
    });
  }
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
