import { readFileDraft, writeFileDraft } from "./file-draft-store";

export type FileSnapshot = { content: string; revision: string };
export type FileDraftSave = (content: string, expectedRevision: string) => Promise<FileSnapshot>;
// Captures an immutable editor document, not a getter into a view that may unmount.
export type FileDraftContent = string | (() => string);
export type FileDraftState = {
  draft: string;
  base?: { revision: string; content?: string };
  remote?: FileSnapshot;
  dirty: boolean;
  conflict: boolean;
  phase: "idle" | "dirty" | "saving" | "saved" | "error";
  storageError: boolean;
  ready: boolean;
  editVersion: number;
  backupPending: boolean;
};

export class FileSaveConflict extends Error {
  constructor() {
    super("workspace_file_conflict");
  }
}

const controllers = new Map<string, FileDraft>();
let unloadGuardInstalled = false;
export function fileDraftFor(key: string): FileDraft {
  if (!unloadGuardInstalled) {
    window.addEventListener("beforeunload", (event) => {
      if (![...controllers.values()].some((draft) => draft.getSnapshot().backupPending)) return;
      event.preventDefault();
      event.returnValue = "";
    });
    unloadGuardInstalled = true;
  }
  let draft = controllers.get(key);
  if (!draft) {
    draft = new FileDraft(key);
    controllers.set(key, draft);
  }
  return draft;
}

// Editor lifetime and backup/save lifetime are independent. Navigation can unmount
// the view while the latest document, backup and file write remain owned here.
export class FileDraft {
  private state: FileDraftState = {
    draft: "",
    dirty: false,
    conflict: false,
    phase: "idle",
    storageError: false,
    ready: false,
    editVersion: 0,
    backupPending: false,
  };
  private listeners = new Set<() => void>();
  private pending?: Promise<boolean>;
  private backup?: Promise<boolean>;
  private recovery: Promise<void>;
  private recovering = false;
  private content?: () => string;
  private version = 0;
  private durableVersion = 0;
  private hasBackup = false;
  private timer?: ReturnType<typeof setTimeout>;
  private backupDue?: number;

  constructor(private readonly key: string) {
    this.recovery = this.restore();
  }

  getSnapshot = (): FileDraftState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.releaseIfClean();
    };
  };

  retryRecovery(): void {
    if (this.state.ready || this.recovering) return;
    this.recovery = this.restore();
  }

  private async restore(): Promise<void> {
    this.recovering = true;
    this.update({ storageError: false });
    try {
      const stored = await readFileDraft(this.key);
      const remote = this.state.remote;
      this.hasBackup = !!stored;
      this.update({
        ready: true,
        storageError: false,
        remote: undefined,
        ...(stored
          ? { base: { revision: stored.baseRevision }, draft: stored.draft, dirty: true, phase: "dirty" }
          : {}),
      });
      if (remote) this.receive(remote);
    } catch (error) {
      console.warn("[file-draft] recovery unavailable", error);
      this.update({ storageError: true });
    } finally {
      this.recovering = false;
    }
  }

  receive(remote: FileSnapshot): void {
    if (!this.state.ready) {
      this.update({ remote });
      return;
    }
    if (this.state.remote?.revision === remote.revision) return;
    const { dirty, phase, draft } = this.state;
    if (phase !== "saving" && (!dirty || (!this.content && draft === remote.content))) {
      const clearBackup = this.hasBackup || this.state.backupPending;
      this.update({ remote, base: remote, draft: remote.content, dirty: false, conflict: false, phase: "idle" });
      if (clearBackup) this.scheduleBackup();
    } else {
      this.update({
        remote,
        conflict: this.state.conflict || remote.revision !== this.state.base?.revision,
        ...(remote.revision === this.state.base?.revision ? { base: remote } : {}),
      });
    }
  }

  edit(content: FileDraftContent): void {
    if (!this.state.ready) return;
    this.content = typeof content === "function" ? content : undefined;
    const dirty = !!this.content || this.state.conflict || content !== this.state.base?.content;
    this.update({
      ...(typeof content === "string" ? { draft: content } : {}),
      dirty,
      editVersion: this.state.editVersion + 1,
      phase: this.pending ? "saving" : dirty ? "dirty" : "idle",
    });
    this.scheduleBackup();
  }

  getContent(): string {
    if (this.content) {
      const draft = this.content();
      this.content = undefined;
      const dirty = this.state.conflict || draft !== this.state.base?.content;
      this.update({ draft, dirty, ...(!dirty && !this.pending ? { phase: "idle" } : {}) });
    }
    return this.state.draft;
  }

  discard(): void {
    if (this.pending || !this.state.remote) return;
    const remote = this.state.remote;
    this.content = undefined;
    this.update({ base: remote, draft: remote.content, dirty: false, conflict: false, phase: "idle" });
    this.scheduleBackup();
    void this.flush();
  }

  // Flush latest content before navigation. A failed file save is independent
  // from whether the draft has a committed backup.
  async flush(): Promise<boolean> {
    await this.recovery;
    if (!this.state.ready) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.backupDue = undefined;
    if (this.backup) return this.backup;
    this.backup = (async () => {
      try {
        while (this.durableVersion !== this.version) {
          const draft = this.getContent();
          const version = this.version;
          const stored =
            this.state.dirty && this.state.base ? { baseRevision: this.state.base.revision, draft } : undefined;
          if (stored || this.hasBackup) await writeFileDraft(this.key, stored);
          this.hasBackup = !!stored;
          this.durableVersion = version;
        }
        this.update({ storageError: false, backupPending: false });
        return true;
      } catch (error) {
        console.warn("[file-draft] persistence unavailable", error);
        this.update({ storageError: true });
        return false;
      }
    })();
    try {
      return await this.backup;
    } finally {
      this.backup = undefined;
      this.releaseIfClean();
    }
  }

  async save(write: FileDraftSave, reviewed?: FileSnapshot): Promise<boolean> {
    await this.recovery;
    if (this.pending) return this.pending;
    if (!this.state.base || !this.state.remote || !this.state.ready) return false;
    if (this.state.conflict && !reviewed) return false;
    if (reviewed && reviewed.revision !== this.state.remote.revision) return false;
    const content = this.getContent();
    if (!this.state.dirty && !reviewed) return true;
    const expected = reviewed ?? this.state.base;
    const remoteAtStart = this.state.remote;
    const editVersion = this.state.editVersion;
    this.update({ phase: "saving" });
    this.pending = (async () => {
      try {
        const saved = await write(content, expected.revision);
        const latest = this.state.remote;
        const remote =
          latest && latest.revision !== remoteAtStart.revision && latest.revision !== saved.revision ? latest : saved;
        const dirty = this.state.editVersion !== editVersion || this.state.draft !== saved.content;
        const changedAgain = remote.revision !== saved.revision;
        this.update({
          base: saved,
          remote,
          dirty: dirty || changedAgain,
          conflict: changedAgain,
          phase: dirty || changedAgain ? "dirty" : "saved",
        });
        this.scheduleBackup();
        return !dirty && !changedAgain;
      } catch (error) {
        console.warn("[file-draft] save failed", error);
        this.update({ phase: "error", conflict: this.state.conflict || error instanceof FileSaveConflict });
        return false;
      } finally {
        this.pending = undefined;
        this.releaseIfClean();
      }
    })();
    return this.pending;
  }

  private scheduleBackup(): void {
    this.version++;
    this.update({ backupPending: true });
    if (this.timer) clearTimeout(this.timer);
    this.backupDue ??= Date.now() + 2_000;
    this.timer = setTimeout(
      () => {
        void this.flush();
      },
      Math.max(0, Math.min(500, this.backupDue - Date.now())),
    );
  }

  private update(patch: Partial<FileDraftState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private releaseIfClean(): void {
    if (
      !this.listeners.size &&
      this.state.ready &&
      !this.state.dirty &&
      !this.state.backupPending &&
      !this.pending &&
      !this.backup &&
      controllers.get(this.key) === this
    )
      controllers.delete(this.key);
  }
}
