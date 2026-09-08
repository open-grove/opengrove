import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "opengrove-draft-backups-"));
let browser;
try {
  const entry = join(temporary, "entry.ts");
  await writeFile(
    entry,
    `
    import { fileDraftFor } from ${JSON.stringify(join(root, "web/src/components/shared/file-draft.ts"))};
    import { readFileDraft } from ${JSON.stringify(join(root, "web/src/components/shared/file-draft-store.ts"))};
    window.draftFor = fileDraftFor;
    window.readBackup = readFileDraft;
  `,
  );
  await build({
    entryPoints: [entry],
    outfile: join(temporary, "entry.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
  });
  const html = join(temporary, "index.html");
  await writeFile(html, '<!doctype html><script src="entry.js"></script>');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(html).href);
  const result = await page.evaluate(async () => {
    const draft = window.draftFor("typing.md");
    draft.subscribe(() => {});
    await draft.flush(); // wait for recovery
    draft.receive({ content: "base", revision: "1" });
    let serializations = 0;
    let writes = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "drafts") writes++;
      return put.apply(this, args);
    };
    for (let i = 0; i < 100; i++)
      draft.edit(() => {
        serializations++;
        return `input ${i}`;
      });
    const immediate = { dirty: draft.getSnapshot().dirty, serializations, writes };
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    const protectedBeforeBackup = unload.defaultPrevented;
    draft.receive({ content: "Agent edit", revision: "2" });
    const conflict = draft.getSnapshot().conflict;
    const preserved = await draft.flush();
    const backedUp = await window.readBackup("typing.md");
    const committed = { serializations, writes };
    const afterBackup = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterBackup);

    // An edit during an asynchronous commit must be included before flush resolves.
    let interrupted = false;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === "drafts" && !interrupted) {
        interrupted = true;
        queueMicrotask(() => draft.edit(() => "input during commit"));
      }
      return request;
    };
    draft.edit(() => "first commit");
    const caughtUp = await draft.flush();
    const latest = await window.readBackup("typing.md");
    IDBObjectStore.prototype.put = put;

    // Several supported-size documents must fit without duplicating their bases.
    const large = [];
    for (let i = 0; i < 3; i++) {
      const file = window.draftFor(`large-${i}.md`);
      file.subscribe(() => {});
      await file.flush();
      file.receive({ content: "a".repeat(1_500_000), revision: "base" });
      file.edit(() => "b".repeat(1_500_000));
      large.push(await file.flush());
    }
    return {
      immediate,
      protectedBeforeBackup,
      conflict,
      preserved,
      backedUp,
      committed,
      protectedAfterBackup: afterBackup.defaultPrevented,
      caughtUp,
      latest,
      large,
    };
  });
  assert.deepEqual(result.immediate, { dirty: true, serializations: 0, writes: 0 });
  assert.equal(result.protectedBeforeBackup, true);
  assert.equal(result.conflict, true);
  assert.equal(result.preserved, true);
  assert.deepEqual(result.backedUp, { baseRevision: "1", draft: "input 99" });
  assert.deepEqual(result.committed, { serializations: 1, writes: 1 });
  assert.equal(result.protectedAfterBackup, false);
  assert.equal(result.caughtUp, true);
  assert.deepEqual(result.latest, { baseRevision: "1", draft: "input during commit" });
  assert.deepEqual(result.large, [true, true, true]);
  await page.reload();
  const recovered = await page.evaluate(async () => {
    const file = window.draftFor("large-2.md");
    await file.flush();
    file.receive({ content: "new disk", revision: "new" });
    const state = file.getSnapshot();
    file.discard();
    await file.flush();
    return {
      length: state.draft.length,
      first: state.draft[0],
      conflict: state.conflict,
      removed: (await window.readBackup("large-2.md")) === undefined,
      adopted: file.getContent(),
    };
  });
  assert.deepEqual(recovered, { length: 1_500_000, first: "b", conflict: true, removed: true, adopted: "new disk" });

  const migration = await page.evaluate(async () => {
    const key = "opengrove:file-draft:v1:legacy.md";
    localStorage.setItem(
      key,
      JSON.stringify({ base: { revision: "old", content: "old text" }, draft: "legacy draft" }),
    );
    const file = window.draftFor("legacy.md");
    file.subscribe(() => {});
    file.receive({ revision: "new", content: "external text" }); // arrives before async recovery
    await file.flush();
    const state = file.getSnapshot();
    const record = await window.readBackup("legacy.md");
    file.discard();
    await file.flush();
    return {
      text: state.draft,
      conflict: state.conflict,
      record,
      legacyRemoved: localStorage.getItem(key) === null,
      discarded: (await window.readBackup("legacy.md")) === undefined,
    };
  });
  assert.deepEqual(migration, {
    text: "legacy draft",
    conflict: true,
    record: { baseRevision: "old", draft: "legacy draft" },
    legacyRemoved: true,
    discarded: true,
  });

  // Continuous typing is backed up periodically, rather than postponing forever.
  const continuous = await page.evaluate(async () => {
    const file = window.draftFor("continuous.md");
    file.subscribe(() => {});
    await file.flush();
    file.receive({ content: "", revision: "0" });
    let edits = 0;
    let serializations = 0;
    const timer = setInterval(() => {
      const value = `edit ${++edits}`;
      file.edit(() => {
        serializations++;
        return value;
      });
    }, 100);
    await new Promise((resolve) => setTimeout(resolve, 2_700));
    clearInterval(timer);
    const backup = await window.readBackup("continuous.md");
    const periodic = !!backup && serializations > 0 && serializations < edits;
    await file.flush();
    return periodic;
  });
  assert.equal(continuous, true);
  assert.deepEqual(errors, []);
  console.log("web-file-draft-backups passed (100 edits: 1 serialization/commit; three 1.5 MB drafts restored)");
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
