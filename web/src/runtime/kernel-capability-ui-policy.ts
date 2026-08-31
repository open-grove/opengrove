export type KernelCapabilityUiTreatment =
  | "composer-control"
  | "message-surface"
  | "activity-surface"
  | "management-surface"
  | "background"
  | "ops-only"
  | "internal-only";

export interface KernelCapabilityUiPolicy {
  capability: string;
  normalUserFacing: boolean;
  treatment: KernelCapabilityUiTreatment;
  implemented: boolean;
  gatedByCapabilityReport: boolean;
  surfaces: string[];
  productRule: string;
}

export const KERNEL_CAPABILITY_UI_POLICIES: KernelCapabilityUiPolicy[] = [
  {
    capability: "message.streamText",
    normalUserFacing: true,
    treatment: "message-surface",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["assistant message stream"],
    productRule: "Render streamed assistant text as normal conversation text; do not show capability vocabulary.",
  },
  {
    capability: "turn.lifecycle",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["composer running state", "send/stop button"],
    productRule: "Show that a turn is running and let the user stop it through the existing composer affordance.",
  },
  {
    capability: "session.lifecycle",
    normalUserFacing: true,
    treatment: "management-surface",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["thread list", "resume/fork flows"],
    productRule: "Use normal conversation/session UI; keep kernel session plumbing internal.",
  },
  {
    capability: "planning.plan",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["composer add menu plan toggle", "active plan chip", "planning activity"],
    productRule: "Show plan mode only when certified planning evidence enables it.",
  },
  {
    capability: "session.goal",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["composer add menu goal toggle", "active goal chip"],
    productRule:
      "Show goal mode only when certified evidence proves the selected kernel has a native persisted goal surface.",
  },
  {
    capability: "interaction.askUser",
    normalUserFacing: true,
    treatment: "message-surface",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["question request card", "multi-question navigation"],
    productRule: "Render kernel/user questions as answerable cards with skip/continue actions.",
  },
  {
    capability: "tools.hostTool",
    normalUserFacing: true,
    treatment: "activity-surface",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["tool activity source label"],
    productRule: "Label OpenGrove-mediated tools in activity rows; do not expose adapter internals.",
  },
  {
    capability: "tools.nativeTool",
    normalUserFacing: true,
    treatment: "activity-surface",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["tool activity source label"],
    productRule: "Label kernel-native tools in activity rows so users know which system acted.",
  },
  {
    capability: "tools.mcpServers",
    normalUserFacing: true,
    treatment: "management-surface",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["slash command /tools connected tools status", "extensions MCP management"],
    productRule: "Show simple connected-tool health, not raw MCP protocol details.",
  },
  {
    capability: "tools.parallelCalls",
    normalUserFacing: false,
    treatment: "activity-surface",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["parallel tool activity rows"],
    productRule: "No dedicated control; the activity stream can naturally show multiple running tool rows.",
  },
  {
    capability: "tool.progress",
    normalUserFacing: true,
    treatment: "activity-surface",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["tool activity running/progress copy"],
    productRule: "Show progress as activity text; keep projection details internal.",
  },
  {
    capability: "approval.request",
    normalUserFacing: true,
    treatment: "message-surface",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["approval card", "access mode picker"],
    productRule: "Ask users to approve risky actions through clear approval cards and permission presets.",
  },
  {
    capability: "control.stop",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["composer stop button"],
    productRule: "Expose this simply as Stop while a turn is running.",
  },
  {
    capability: "control.steer",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["queued instruction guide action"],
    productRule:
      "Enable Guide only when same-turn steer has certified evidence; otherwise leave the instruction queued.",
  },
  {
    capability: "session.compact",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["slash command /compact", "compaction activity notes"],
    productRule: "Expose compaction as a command/status when certified; do not imply it exists for every kernel.",
  },
  {
    capability: "auth.refresh",
    normalUserFacing: false,
    treatment: "background",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["auth/login recovery"],
    productRule: "Refresh in the background when possible; show UI only when user login action is required.",
  },
  {
    capability: "sandbox.policy",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["access mode picker", "approval warnings"],
    productRule: "Fold sandbox behavior into permission presets and risk warnings, not raw sandbox flags.",
  },
  {
    capability: "budget.limit",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["model menu budget control"],
    productRule: "Show hard budget controls only for kernels with certified budget.limit evidence.",
  },
  {
    capability: "diagnostics.usage",
    normalUserFacing: false,
    treatment: "ops-only",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["ops/debug usage diagnostics"],
    productRule: "Keep raw usage events in diagnostics; product UI may show only simple summaries.",
  },
  {
    capability: "response.speed",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["model menu speed controls"],
    productRule:
      "Show speed controls only when certified evidence proves OpenGrove passes a native speed or service-tier setting.",
  },
  {
    capability: "media.input",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["composer attachment picker", "native media input selector"],
    productRule:
      "The attachment UI stays generic; only the native media delivery path is enabled when the selected kernel has certified media.input evidence.",
  },
  {
    capability: "output.structured",
    normalUserFacing: false,
    treatment: "internal-only",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["schema-bound runtime requests"],
    productRule: "Use internally for schema-bound tasks; do not add a normal-user control by default.",
  },
  {
    capability: "output.artifacts",
    normalUserFacing: true,
    treatment: "message-surface",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["activity artifact cards", "artifact gallery"],
    productRule: "Render files/images/deliverables as reusable artifact cards instead of raw tool JSON.",
  },
  {
    capability: "reasoning.nativeText",
    normalUserFacing: true,
    treatment: "message-surface",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["reasoning activity when the kernel emits native text"],
    productRule:
      "Render only text actually emitted by the Kernel; do not infer, reconstruct, or relabel it as a summary.",
  },
  {
    capability: "reasoning.summary",
    normalUserFacing: true,
    treatment: "composer-control",
    implemented: true,
    gatedByCapabilityReport: true,
    surfaces: ["model menu reasoning controls", "reasoning activity when available"],
    productRule: "Show reasoning controls or summaries only when certified evidence proves they are effective.",
  },
  {
    capability: "knowledge.skills",
    normalUserFacing: true,
    treatment: "management-surface",
    implemented: true,
    gatedByCapabilityReport: false,
    surfaces: ["slash skill palette", "skill library"],
    productRule: "Show skills as invocable abilities; keep projection mechanics internal.",
  },
];

export function kernelCapabilityUiPolicy(capability: string): KernelCapabilityUiPolicy | undefined {
  return KERNEL_CAPABILITY_UI_POLICIES.find((policy) => policy.capability === capability);
}
