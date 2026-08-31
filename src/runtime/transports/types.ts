export type KernelTransportKind =
  | "acp"
  | "stdio-jsonrpc"
  | "http-sse"
  | "websocket-gateway"
  | "pty-terminal"
  | "oneshot-cli"
  | "sdk-inprocess";

export interface KernelTransportDescriptor {
  kind: KernelTransportKind;
  title: string;
  sessionful: boolean;
  streaming: boolean;
  bidirectional: boolean;
  structuredToolEvents: boolean;
  hostCanAnswerNativeRequests: boolean;
  notes?: string[];
}

export const KERNEL_TRANSPORT_DESCRIPTORS: Record<KernelTransportKind, KernelTransportDescriptor> = {
  acp: {
    kind: "acp",
    title: "Agent Client Protocol",
    sessionful: true,
    streaming: true,
    bidirectional: true,
    structuredToolEvents: true,
    hostCanAnswerNativeRequests: true,
    notes: ["Line-delimited JSON-RPC over stdio with session/update notifications and native permission requests."],
  },
  "stdio-jsonrpc": {
    kind: "stdio-jsonrpc",
    title: "Stdio JSON-RPC",
    sessionful: true,
    streaming: true,
    bidirectional: true,
    structuredToolEvents: true,
    hostCanAnswerNativeRequests: true,
    notes: ["Generic request/response JSON-RPC over a child process stdio boundary."],
  },
  "http-sse": {
    kind: "http-sse",
    title: "HTTP + SSE",
    sessionful: true,
    streaming: true,
    bidirectional: false,
    structuredToolEvents: true,
    hostCanAnswerNativeRequests: false,
    notes: ["Good for model APIs and app servers, but native permission callbacks need an extra channel."],
  },
  "websocket-gateway": {
    kind: "websocket-gateway",
    title: "Gateway WebSocket",
    sessionful: true,
    streaming: true,
    bidirectional: true,
    structuredToolEvents: true,
    hostCanAnswerNativeRequests: true,
    notes: ["Request/response/event frames over a persistent gateway socket, as in OpenClaw."],
  },
  "pty-terminal": {
    kind: "pty-terminal",
    title: "PTY terminal",
    sessionful: true,
    streaming: true,
    bidirectional: true,
    structuredToolEvents: false,
    hostCanAnswerNativeRequests: true,
    notes: ["Preserves the real terminal boundary, but requires terminal-state parsing for semantics."],
  },
  "oneshot-cli": {
    kind: "oneshot-cli",
    title: "One-shot CLI",
    sessionful: false,
    streaming: false,
    bidirectional: false,
    structuredToolEvents: false,
    hostCanAnswerNativeRequests: false,
    notes: ["Last-resort process execution: pass prompt in, collect stdout/stderr out."],
  },
  "sdk-inprocess": {
    kind: "sdk-inprocess",
    title: "In-process SDK",
    sessionful: true,
    streaming: true,
    bidirectional: true,
    structuredToolEvents: true,
    hostCanAnswerNativeRequests: true,
    notes: ["Best when the upstream kernel exposes its harness as a typed library API."],
  },
};

export function kernelTransportDescriptor(kind: KernelTransportKind): KernelTransportDescriptor {
  return KERNEL_TRANSPORT_DESCRIPTORS[kind];
}
