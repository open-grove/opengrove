import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexAuthRefreshResponse } from "../runtime/codex/auth.js";

test("Codex 0.162 external token refresh returns the required fields without refresh credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-auth-shape-"));
  writeFileSync(
    join(root, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "test-access",
        account_id: "test-account",
        refresh_token: "must-not-send",
        id_token: "must-not-send",
      },
    }),
  );
  assert.deepEqual(readCodexAuthRefreshResponse({ CODEX_HOME: root }), {
    accessToken: "test-access",
    chatgptAccountId: "test-account",
  });
});
