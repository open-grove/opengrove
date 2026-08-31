import { build } from "esbuild";
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const roomsSharedStatePath = fileURLToPath(
  new URL("../../web/src/components/rooms/rooms-shared-state.ts", import.meta.url),
);

let harnessScript = "";

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { useRoomsSharedState } from ${JSON.stringify(roomsSharedStatePath)};

        function RoomsSyncHarness() {
          const [sessionKey, setSessionKey] = useState("local");
          globalThis.__setRoomsSessionKey = setSessionKey;
          const { snapshot } = useRoomsSharedState({
            enabled: true,
            sessionKey,
          });
          return React.createElement(
            "pre",
            { id: "rooms-state", "data-session-key": sessionKey },
            JSON.stringify(snapshot),
          );
        }

        createRoot(document.getElementById("root")).render(
          React.createElement(RoomsSyncHarness),
        );
      `,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  harnessScript = result.outputFiles[0]?.text ?? "";
});

test("a new session installs a Room snapshot before polling events", async ({ page }) => {
  await page.route("http://opengrove.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: '<main id="root"></main>',
    });
  });
  await page.goto("http://opengrove.test/");

  await page.evaluate(() => {
    const scopedDefaultRoom = {
      id: "app-room--story-seed--group--default",
      kind: "group",
      scope: { kind: "app", appId: "story-seed", role: "default" },
      title: "故事种子 群组",
      badge: "💬",
      memberIds: [],
      adminMemberIds: [],
      updatedAt: "2026-08-20T09:44:36.465Z",
      unread: 0,
    };
    const legacyUnscopedRoom = {
      ...scopedDefaultRoom,
      scope: undefined,
    };
    const requests: string[] = [];
    Object.assign(globalThis, {
      __OPENGROVE_API_BASE__: "http://bridge.test",
      __roomsRequests: requests,
      fetch: async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        const parsed = new URL(url);
        if (parsed.pathname === "/rooms") {
          return Response.json({
            ok: true,
            rooms: [scopedDefaultRoom],
            members: [],
            messages: [],
            currentEventSeq: 3180,
            deletedMemberIds: [],
          });
        }
        if (parsed.pathname === "/rooms/events") {
          const afterEventSeq = Number(parsed.searchParams.get("afterEventSeq"));
          if (afterEventSeq === 0) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return Response.json({
              ok: true,
              events: [
                {
                  schemaVersion: 1,
                  eventSeq: 1,
                  type: "room.created",
                  roomId: legacyUnscopedRoom.id,
                  createdAt: "2026-08-01T00:00:00.000Z",
                  payload: { room: legacyUnscopedRoom },
                },
              ],
              currentEventSeq: 3180,
              oldestAvailableEventSeq: 1,
              hasMore: false,
              resetRequired: false,
              longPollSupported: true,
            });
          }
          return Response.json({
            ok: true,
            events: [],
            currentEventSeq: 3180,
            oldestAvailableEventSeq: 1,
            hasMore: false,
            resetRequired: false,
            longPollSupported: true,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  await page.addScriptTag({ content: harnessScript, type: "module" });
  const state = page.locator("#rooms-state");
  await expect(state).toContainText('"hydrated":true');
  await expect(state).toContainText('"appId":"story-seed"');

  await page.evaluate(() => {
    const setSessionKey = (
      globalThis as typeof globalThis & {
        __setRoomsSessionKey: (sessionKey: string) => void;
      }
    ).__setRoomsSessionKey;
    setSessionKey("account:anonymous");
  });

  await expect(state).toHaveAttribute("data-session-key", "account:anonymous");
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            (globalThis as typeof globalThis & { __roomsRequests: string[] }).__roomsRequests.filter(
              (url) => new URL(url).pathname === "/rooms",
            ).length,
        ),
    )
    .toBe(2);
  await expect(state).toContainText('"hydrated":true');
  await expect.poll(async () => await state.textContent()).toContain('"appId":"story-seed"');
  expect(
    await page.evaluate(() =>
      (globalThis as typeof globalThis & { __roomsRequests: string[] }).__roomsRequests.some((url) => {
        const parsed = new URL(url);
        return parsed.pathname === "/rooms/events" && parsed.searchParams.get("afterEventSeq") === "0";
      }),
    ),
  ).toBe(false);
});
