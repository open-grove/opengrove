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
    window.readBackup = async (key) => (await readFileDraft(key)).draft;
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
  // Adding quarantine storage preserves valid records from the existing database.
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("opengrove-file-drafts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite");
      transaction
        .objectStore("drafts")
        .put({ baseRevision: "before", draft: "existing IndexedDB draft" }, "existing.md");
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
  const unavailable = await page.evaluate(async () => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = () => {
      throw new DOMException("storage disabled", "SecurityError");
    };
    const file = window.draftFor("unavailable.md");
    file.subscribe(() => {});
    file.receive({ content: "disk content", revision: "disk" });
    const cleanCanLeave = await file.flush();
    const ready = file.getSnapshot().ready;
    file.edit(() => "in-memory input");
    const backedUp = await file.flush();
    const beforeSave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeSave);
    const content = file.getContent();
    const saved = await file.save(async (content, revision) => {
      if (revision !== "disk") throw new Error("wrong base after failed recovery");
      return { content, revision: "saved" };
    });
    const afterSave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterSave);
    IDBFactory.prototype.open = open;
    return {
      cleanCanLeave,
      ready,
      content,
      backedUp,
      saved,
      beforeSave: beforeSave.defaultPrevented,
      afterSave: afterSave.defaultPrevented,
    };
  });
  assert.deepEqual(unavailable, {
    cleanCanLeave: true,
    ready: true,
    content: "in-memory input",
    backedUp: false,
    saved: true,
    beforeSave: true,
    afterSave: false,
  });

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
  assert.deepEqual(await page.evaluate(() => window.readBackup("existing.md")), {
    baseRevision: "before",
    draft: "existing IndexedDB draft",
  });
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

  const corrupt = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("opengrove-file-drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const broken = { draft: "recoverable old words", baseRevision: 42 };
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put(broken, "corrupt.md");
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    const file = window.draftFor("corrupt.md");
    file.subscribe(() => {});
    file.receive({ content: "current disk", revision: "disk" });
    await file.flush();
    const state = file.getSnapshot();
    file.edit(() => "new input");
    const backedUp = await file.flush();
    return { ready: state.ready, memoryOnly: state.memoryOnly, draft: state.draft, backedUp };
  });
  assert.deepEqual(corrupt, { ready: true, memoryOnly: false, draft: "current disk", backedUp: true });

  const quarantined = await page.evaluate(async () => {
    const request = indexedDB.open("opengrove-file-drafts");
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise((resolve, reject) => {
      const read = database.transaction("quarantined-drafts").objectStore("quarantined-drafts").get("corrupt.md");
      read.onsuccess = () => resolve(read.result.value);
      read.onerror = () => reject(read.error);
    });
    database.close();
    return value;
  });
  assert.deepEqual(quarantined, { draft: "recoverable old words", baseRevision: 42 });
  await page.reload();
  const healthyAgain = await page.evaluate(async () => {
    const file = window.draftFor("corrupt.md");
    file.subscribe(() => {});
    file.receive({ content: "current disk", revision: "disk" });
    await file.flush();
    return { content: file.getContent(), memoryOnly: file.getSnapshot().memoryOnly };
  });
  assert.deepEqual(healthyAgain, { content: "new input", memoryOnly: false });

  // A transient read failure must not let new edits silently replace an unread backup.
  const unread = await page.evaluate(async () => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (key === "typing.md") throw new DOMException("read unavailable", "InvalidStateError");
      return get.call(this, key);
    };
    const file = window.draftFor("typing.md");
    file.subscribe(() => {});
    file.receive({ content: "current disk", revision: "disk" });
    await file.flush();
    IDBObjectStore.prototype.get = get;
    file.edit(() => "new memory-only edit");
    const preserved = await file.flush();
    const previous = await window.readBackup("typing.md");
    file.discard();
    return { preserved, previous };
  });
  assert.deepEqual(unread, { preserved: false, previous: { baseRevision: "1", draft: "input during commit" } });

  const quarantineFailure = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("opengrove-file-drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put({ draft: "retained damaged backup" }, "cannot-quarantine.md");
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "quarantined-drafts") throw new DOMException("storage full", "QuotaExceededError");
      return put.apply(this, args);
    };
    const file = window.draftFor("cannot-quarantine.md");
    file.subscribe(() => {});
    file.receive({ content: "disk text", revision: "disk" });
    await file.flush();
    IDBObjectStore.prototype.put = put;
    const original = await new Promise((resolve, reject) => {
      const read = database.transaction("drafts").objectStore("drafts").get("cannot-quarantine.md");
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    database.close();
    return { ready: file.getSnapshot().ready, memoryOnly: file.getSnapshot().memoryOnly, original };
  });
  assert.deepEqual(quarantineFailure, {
    ready: true,
    memoryOnly: true,
    original: { draft: "retained damaged backup" },
  });

  const orphanedPreview = await page.evaluate(async () => {
    localStorage.setItem("opengrove:file-draft:v1:preview.md", "invalid JSON from an unreleased preview");
    const file = window.draftFor("preview.md");
    file.subscribe(() => {});
    file.receive({ revision: "disk", content: "disk content" });
    await file.flush();
    return { ready: file.getSnapshot().ready, memoryOnly: file.getSnapshot().memoryOnly, text: file.getContent() };
  });
  assert.deepEqual(orphanedPreview, { ready: true, memoryOnly: false, text: "disk content" });

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
