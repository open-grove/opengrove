export interface KnowledgeFilePatchPayload {
  content: string;
  title?: string;
  tags?: string[];
}

export interface KnowledgeFileSystemCreatePayload {
  kind: "note" | "folder";
  parentPath?: string;
  name?: string;
  content?: string;
}

export interface KnowledgeFileSystemMovePayload {
  sourcePath?: string;
  targetParentPath?: string;
}

export interface KnowledgeFileSystemRenamePayload {
  sourcePath?: string;
  name?: string;
}

export interface KnowledgeFileSystemDeletePayload {
  sourcePath?: string;
}

export interface KnowledgeFileSystemImportFolderPayload {
  folderPath?: string;
}

export function normalizeKnowledgeFilePatchPayload(input: unknown): KnowledgeFilePatchPayload {
  const object = record(input);
  if (typeof object.content !== "string") {
    throw new Error("knowledge_file_content_required");
  }
  return {
    content: object.content,
    title: typeof object.title === "string" ? object.title : undefined,
    tags: stringArray(object.tags),
  };
}

export function normalizeKnowledgeFileSystemCreatePayload(input: unknown): KnowledgeFileSystemCreatePayload {
  const object = record(input);
  return {
    kind: object.kind === "folder" ? "folder" : "note",
    parentPath: typeof object.parentPath === "string" ? object.parentPath : undefined,
    name: typeof object.name === "string" ? object.name : undefined,
    content: typeof object.content === "string" ? object.content : undefined,
  };
}

export function normalizeKnowledgeFileSystemMovePayload(input: unknown): KnowledgeFileSystemMovePayload {
  const object = record(input);
  return {
    sourcePath: typeof object.sourcePath === "string" ? object.sourcePath : undefined,
    targetParentPath: typeof object.targetParentPath === "string" ? object.targetParentPath : undefined,
  };
}

export function normalizeKnowledgeFileSystemRenamePayload(input: unknown): KnowledgeFileSystemRenamePayload {
  const object = record(input);
  return {
    sourcePath: typeof object.sourcePath === "string" ? object.sourcePath : undefined,
    name: typeof object.name === "string" ? object.name : undefined,
  };
}

export function normalizeKnowledgeFileSystemDeletePayload(input: unknown): KnowledgeFileSystemDeletePayload {
  const object = record(input);
  return {
    sourcePath: typeof object.sourcePath === "string" ? object.sourcePath : undefined,
  };
}

export function normalizeKnowledgeFileSystemImportFolderPayload(
  input: unknown,
): KnowledgeFileSystemImportFolderPayload {
  const object = record(input);
  return {
    folderPath: typeof object.folderPath === "string" ? object.folderPath : undefined,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}
