import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { sendJson } from "../server/http-utils.js";

test("sendJson serializes undefined as valid JSON", () => {
  let headers: Record<string, string> | undefined;
  let body: string | undefined;
  const response = {
    writeHead(_status: number, value: Record<string, string>) {
      headers = value;
    },
    end(value: string) {
      body = value;
    },
  } as unknown as ServerResponse;

  sendJson(response, 200, undefined);

  assert.equal(body, "null");
  assert.equal(headers?.["content-length"], "4");
});
