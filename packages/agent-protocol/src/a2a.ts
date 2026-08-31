import { z } from "zod";

export const A2A_PROTOCOL_VERSION = "1.0";

export const a2aTaskStateSchema = z.enum([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export type A2ATaskState = z.infer<typeof a2aTaskStateSchema>;

export const a2aTerminalTaskStates = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
] as const satisfies readonly A2ATaskState[];

export function isA2ATerminalTaskState(state: A2ATaskState): boolean {
  return (a2aTerminalTaskStates as readonly string[]).includes(state);
}

export type A2AProtocolBinding = "JSONRPC" | "HTTP+JSON" | "GRPC" | string;

export interface A2AAgentInterface {
  url: string;
  protocolBinding: A2AProtocolBinding;
  tenant?: string;
  protocolVersion: typeof A2A_PROTOCOL_VERSION | string;
}

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: A2AAgentExtension[];
}

export interface A2AAgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface A2ASecurityScheme {
  type: string;
  description?: string;
  [key: string]: unknown;
}

export type A2ASecurityRequirement = Record<string, string[]>;

export interface A2AAgentProvider {
  organization?: string;
  url?: string;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  metadata?: Record<string, unknown>;
}

export interface OpenGroveAgentCardExtensions {
  employeeId: string;
  ownerUserId?: string;
  kernel?: string;
  model?: string;
  reasoningEffort?: string;
  visibility?: "private" | "public";
  publicDescription?: string;
  publicSkills?: string[];
  inputSpec?: string;
  outputSpec?: string;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  supportedInterfaces: A2AAgentInterface[];
  provider?: A2AAgentProvider;
  version: string;
  documentationUrl?: string;
  capabilities: A2AAgentCapabilities;
  securitySchemes?: Record<string, A2ASecurityScheme>;
  securityRequirements?: A2ASecurityRequirement[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  signatures?: Record<string, unknown>[];
  metadata?: {
    ogExtensions?: OpenGroveAgentCardExtensions;
    [key: string]: unknown;
  };
}

export interface A2ATextPart {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface A2ADataPart {
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface A2ARawPart {
  raw: {
    name?: string;
    mimeType?: string;
    bytes: string;
  };
  metadata?: Record<string, unknown>;
}

export interface A2AUrlPart {
  url: string;
  metadata?: Record<string, unknown>;
}

export type A2APart = A2ATextPart | A2ADataPart | A2ARawPart | A2AUrlPart;

export interface A2AMessage {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2ATaskArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  artifacts?: A2ATaskArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

export interface A2ASendMessageRequest {
  tenant?: string;
  message: A2AMessage;
  metadata?: Record<string, unknown>;
}

export interface A2AGetTaskRequest {
  tenant?: string;
  id: string;
  historyLength?: number;
  metadata?: Record<string, unknown>;
}

export interface A2AListTasksRequest {
  tenant?: string;
  contextId?: string;
  status?: A2ATaskState;
  pageSize?: number;
  pageToken?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ACancelTaskRequest {
  tenant?: string;
  id: string;
  metadata?: Record<string, unknown>;
}

const metadataSchema = z.record(z.string(), z.unknown());

export const a2aAgentInterfaceSchema = z.object({
  url: z.string().min(1),
  protocolBinding: z.string().min(1),
  tenant: z.string().optional(),
  protocolVersion: z.string().min(1),
});

export const openGroveAgentCardExtensionsSchema = z.object({
  employeeId: z.string().min(1),
  ownerUserId: z.string().optional(),
  kernel: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  visibility: z.enum(["private", "public"]).optional(),
  publicDescription: z.string().optional(),
  publicSkills: z.array(z.string()).optional(),
  inputSpec: z.string().optional(),
  outputSpec: z.string().optional(),
});

export const a2aAgentSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
  metadata: metadataSchema.optional(),
});

export const a2aAgentCardSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  supportedInterfaces: z.array(a2aAgentInterfaceSchema).min(1),
  provider: z
    .object({
      organization: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  version: z.string().min(1),
  documentationUrl: z.string().optional(),
  capabilities: z.object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extensions: z
      .array(
        z.object({
          uri: z.string().min(1),
          description: z.string().optional(),
          required: z.boolean().optional(),
          params: metadataSchema.optional(),
        }),
      )
      .optional(),
  }),
  securitySchemes: z
    .record(
      z.string(),
      z
        .object({
          type: z.string().min(1),
          description: z.string().optional(),
        })
        .catchall(z.unknown()),
    )
    .optional(),
  securityRequirements: z.array(z.record(z.string(), z.array(z.string()))).optional(),
  defaultInputModes: z.array(z.string()).min(1),
  defaultOutputModes: z.array(z.string()).min(1),
  skills: z.array(a2aAgentSkillSchema),
  signatures: z.array(metadataSchema).optional(),
  metadata: metadataSchema
    .and(
      z
        .object({
          ogExtensions: openGroveAgentCardExtensionsSchema.optional(),
        })
        .partial(),
    )
    .optional(),
});

export const a2aTextPartSchema = z.object({
  text: z.string(),
  metadata: metadataSchema.optional(),
});

export const a2aDataPartSchema = z.object({
  data: metadataSchema,
  metadata: metadataSchema.optional(),
});

export const a2aRawPartSchema = z.object({
  raw: z.object({
    name: z.string().optional(),
    mimeType: z.string().optional(),
    bytes: z.string().min(1),
  }),
  metadata: metadataSchema.optional(),
});

export const a2aUrlPartSchema = z.object({
  url: z.string().min(1),
  metadata: metadataSchema.optional(),
});

export const a2aPartSchema = z.union([a2aTextPartSchema, a2aDataPartSchema, a2aRawPartSchema, a2aUrlPartSchema]);

export const a2aMessageSchema = z.object({
  messageId: z.string().min(1),
  role: z.enum(["ROLE_USER", "ROLE_AGENT"]),
  parts: z.array(a2aPartSchema).min(1),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  metadata: metadataSchema.optional(),
});

export const a2aTaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().optional(),
  status: z.object({
    state: a2aTaskStateSchema,
    message: a2aMessageSchema.optional(),
    timestamp: z.string().optional(),
  }),
  artifacts: z
    .array(
      z.object({
        artifactId: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
        parts: z.array(a2aPartSchema),
        metadata: metadataSchema.optional(),
      }),
    )
    .optional(),
  history: z.array(a2aMessageSchema).optional(),
  metadata: metadataSchema.optional(),
});
