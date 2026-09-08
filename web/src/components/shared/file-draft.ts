export type FileSnapshot = { content: string; revision: string };
export type FileDraftSave = (content: string, expectedRevision: string) => Promise<FileSnapshot>;
export type FileDraftState = {
  draft: string;
  base?: FileSnapshot;
  remote?: FileSnapshot;
  dirty: boolean;
  conflict: boolean;
  phase: "idle" | "dirty" | "saving" | "saved" | "error";
  storageError: boolean;
};

export class FileSaveConflict extends Error {
  constructor() {
    super("workspace_file_conflict");
  }
}

const controllers = new Map<string, FileDraft>();
export function fileDraftFor(key: string): FileDraft {
  let draft = controllers.get(key);
  if (!draft) {
    draft = new FileDraft(key);
    controllers.set(key, draft);
  }
  return draft;
}

// One controller per workspace/file keeps an in-flight save attached to its
// original document when the user navigates away and back.
export class FileDraft {
  private state: FileDraftState = { draft: "", dirty: false, conflict: false, phase: "idle", storageError: false };
  private listeners = new Set<() => void>();
  private pending?: Promise<boolean>;
  private readonly storageKey: string;

  constructor(private readonly key: string) {
    this.storageKey = `opengrove:file-draft:v1:${key}`;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (!isStoredDraft(value)) throw new Error("invalid_file_draft");
        this.state = { ...this.state, base: value.base, draft: value.draft, dirty: true, phase: "dirty" };
      }
    } catch (error) {
      console.warn("[file-draft] recovery unavailable", error);
      this.state.storageError = true;
    }
  }

  getSnapshot = (): FileDraftState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.releaseIfClean();
    };
  };

  receive(remote: FileSnapshot): void {
    if (this.state.remote?.revision === remote.revision) return;
    const { dirty, phase, draft } = this.state;
    if (phase !== "saving" && (!dirty || draft === remote.content)) {
      this.update({ remote, base: remote, draft: remote.content, dirty: false, conflict: false, phase: "idle" });
    } else {
      this.update({ remote, conflict: this.state.conflict || remote.revision !== this.state.base?.revision });
    }
  }

  edit(draft: string): void {
    const dirty = this.state.conflict || draft !== this.state.base?.content;
    this.update({ draft, dirty, phase: this.pending ? "saving" : dirty ? "dirty" : "idle" });
  }

  discard(): void {
    if (this.pending || !this.state.remote) return;
    const remote = this.state.remote;
    this.update({ base: remote, draft: remote.content, dirty: false, conflict: false, phase: "idle" });
  }

  save(write: FileDraftSave, reviewed?: FileSnapshot): Promise<boolean> {
    if (this.pending) return this.pending;
    if (!this.state.base || !this.state.remote) return Promise.resolve(false);
    if (this.state.conflict && !reviewed) return Promise.resolve(false);
    if (reviewed && reviewed.revision !== this.state.remote.revision) return Promise.resolve(false);
    if (!this.state.dirty && !reviewed) return Promise.resolve(true);
    const content = this.state.draft;
    const expected = reviewed ?? this.state.base;
    const remoteAtStart = this.state.remote;
    this.update({ phase: "saving" });
    this.pending = (async () => {
      try {
        const saved = await write(content, expected.revision);
        const latest = this.state.remote;
        const remote =
          latest && latest.revision !== remoteAtStart.revision && latest.revision !== saved.revision ? latest : saved;
        const dirty = this.state.draft !== saved.content;
        // A newer external version received during a save must remain visible
        // as a conflict, even if the submitted draft has just been saved.
        const changedAgain = remote.revision !== saved.revision;
        this.update({
          base: saved,
          remote,
          dirty: dirty || changedAgain,
          conflict: changedAgain,
          phase: dirty || changedAgain ? "dirty" : "saved",
        });
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

  private update(patch: Partial<FileDraftState>): void {
    this.state = { ...this.state, ...patch };
    try {
      if (this.state.dirty && this.state.base) {
        localStorage.setItem(this.storageKey, JSON.stringify({ base: this.state.base, draft: this.state.draft }));
      } else {
        localStorage.removeItem(this.storageKey);
      }
      this.state.storageError = false;
    } catch (error) {
      console.warn("[file-draft] persistence unavailable", error);
      this.state.storageError = true;
    }
    this.listeners.forEach((listener) => listener());
  }

  private releaseIfClean(): void {
    if (!this.listeners.size && !this.state.dirty && !this.pending) controllers.delete(this.key);
  }
}

function isStoredDraft(value: unknown): value is { base: FileSnapshot; draft: string } {
  if (!value || typeof value !== "object" || !("base" in value) || !("draft" in value)) return false;
  const base = value.base;
  return (
    typeof value.draft === "string" &&
    !!base &&
    typeof base === "object" &&
    "content" in base &&
    typeof base.content === "string" &&
    "revision" in base &&
    typeof base.revision === "string"
  );
}
