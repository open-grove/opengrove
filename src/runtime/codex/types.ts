import type { ApprovalPolicy, JsonObject, JsonValue } from "../../core.js";
import type { CodexRpcCaptureOptions } from "../codex-rpc-capture.js";

export type CodexApprovalPolicy = ApprovalPolicy;
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type CodexThreadSource = "user" | "subagent" | "memory_consolidation";

export interface CodexRuntimeOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  statePath?: string;
  configuredModel?: string;
  configuredModelProvider?: string;
  runtimeBindingFingerprint?: string;
  providerConfig?: CodexModelProviderRuntimeConfig;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxMode;
  approvalsReviewer?: CodexApprovalsReviewer;
  serviceTier?: string;
  allowServiceTier?: boolean;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  rpcCapture?: CodexRpcCaptureOptions;
  threadSource?: CodexThreadSource;
}

export type CodexModelProviderRuntimeConfig = {
  providerKey: string;
  name: string;
  baseUrl: string;
  envKey: string;
  wireApi: "chat" | "responses";
};

export type RpcRequest = {
  id?: number | string;
  method: string;
  params?: JsonValue;
};

export type RpcResponse = {
  id: number | string;
  result?: JsonValue;
  error?: {
    code?: number;
    message: string;
    data?: JsonValue;
  };
};

export type RpcMessage = RpcRequest | RpcResponse;

export type CodexDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

export type CodexDynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: JsonValue;
};

export type CodexDynamicToolCallResponse = {
  contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>;
  success: boolean;
};

export type CodexThreadBinding = {
  threadId: string;
  dynamicToolsFingerprint: string;
  runtimeBindingFingerprint?: string;
  model?: string;
  modelProvider?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
};

export type CodexThreadStartResponse = {
  thread?: {
    id?: string;
  };
  model?: string | null;
  modelProvider?: string | null;
};

export type CodexTurnStartResponse = {
  turn?: {
    id?: string;
    status?: string;
  };
};

export type CodexInitializeResponse = {
  userAgent?: string;
  codexHome?: string;
};

export type CodexTurnInputItem =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type ServerRequestHandler = (request: {
  id: number | string;
  method: string;
  params?: JsonValue;
}) => Promise<JsonValue | undefined> | JsonValue | undefined;

export type ServerNotificationHandler = (notification: { method: string; params?: JsonValue }) => void | Promise<void>;

export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const MIN_CODEX_APP_SERVER_VERSION = "0.125.0";
// Feature flags that older Codex CLIs accept via `--disable` but newer builds removed.
// Passing one to a build that no longer knows it makes `codex app-server` abort at
// startup with `Unknown feature flag: <name>` (exit code 1). We start with them enabled
// (so older builds that still need them keep working) and drop them automatically when a
// launch fails with that exact error — see stripDisableFeatureFlags below and the
// fallback in CodexRuntime. No version number is hard-coded because the exact removal
// release is not known here, so detection is purely behavioral.
export const CODEX_OPTIONAL_DISABLE_FEATURE_FLAGS = ["responses_websocket_response_processed"] as const;
export const DEFAULT_CODEX_APP_SERVER_ARGS = [
  "app-server",
  "--disable",
  "responses_websockets",
  "--disable",
  "responses_websockets_v2",
  ...CODEX_OPTIONAL_DISABLE_FEATURE_FLAGS.flatMap((flag) => ["--disable", flag]),
  "--listen",
  "stdio://",
];
export const CODEX_THREAD_CONFIG_OVERRIDES: JsonObject = {
  "features.responses_websockets": false,
  "features.responses_websockets_v2": false,
  // `features.responses_websocket_response_processed` is intentionally omitted: the
  // matching `--disable` launch flag (handled adaptively above) already covers builds
  // that recognize the feature, and newer builds dropped it entirely.
  "features.image_generation": true,
  suppress_unstable_features_warning: true,
};

const UNKNOWN_FEATURE_FLAG_PATTERN = /Unknown feature flag:\s*([A-Za-z0-9_.-]+)/g;

// Reads the feature-flag name(s) a Codex app-server rejected from its stderr.
export function unknownCodexFeatureFlagsFromStderr(stderr: string): string[] {
  const names = new Set<string>();
  for (const match of stderr.matchAll(UNKNOWN_FEATURE_FLAG_PATTERN)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

// Removes `--disable <flag>` pairs for the given flag names. Returns the same array
// reference when nothing matched so callers can cheaply detect "no change".
export function stripDisableFeatureFlags(args: string[], flags: string[]): string[] {
  if (!flags.length) return args;
  const drop = new Set(flags);
  const next: string[] = [];
  let changed = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--disable" && drop.has(args[index + 1] ?? "")) {
      index += 1;
      changed = true;
      continue;
    }
    next.push(args[index]!);
  }
  return changed ? next : args;
}
