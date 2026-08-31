export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface TextPart {
  id: string;
  type: "text";
  text: string;
}

export interface NotePart {
  id: string;
  type: "note";
  text: string;
  tone: string;
  data?: JsonValue | undefined;
}

export interface ReasoningPart {
  id: string;
  type: "reasoning";
  reasoningId: string;
  kernelId: string;
  kind: "native" | "summary";
  text: string;
  status: string;
  redacted: boolean;
  elapsedMs?: number | undefined;
}

export interface ToolPart {
  id: string;
  type: "tool";
  phase: string;
  toolId: string;
  callId?: string | undefined;
  title: string;
  input?: JsonValue | undefined;
  status: string;
  result?: JsonValue | undefined;
  error: string;
  approvalId: string;
  approvalStatus: string;
  approvalReason: string;
  approvalInput?: JsonValue | undefined;
  questionId: string;
  questionStatus: string;
  questionPrompt: string;
  questionInput?: JsonValue | undefined;
}

export interface SkillPart {
  id: string;
  type: "skill";
  skillId: string;
  skillName: string;
  title: string;
  status: string;
  contentPreview: string;
  allowedTools: string[];
  model: string;
  effort: string;
  forkSessionId: string;
  result: string;
  description: string;
  whenToUse: string;
  source: string;
  trust: string;
  context: string;
  packId: string;
}

export type MessagePart = TextPart | NotePart | ReasoningPart | ToolPart | SkillPart;

export interface AttachmentPayload {
  id: string;
  name: string;
  kind: "image" | "text" | "file";
  mimeType: string;
  size: number;
  text?: string;
  dataUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}

export interface ContextArtifactPayload {
  id: string;
  title: string;
  type: string;
  summary: string;
  imageUri?: string;
}

export interface MessageContext {
  text: string;
  selectedText?: string;
  attachments?: AttachmentPayload[];
  artifacts?: ContextArtifactPayload[];
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  context: MessageContext | null;
  parts: MessagePart[];
  pending: boolean;
  runId: string;
  startedAt?: string;
  finishedAt?: string;
}
