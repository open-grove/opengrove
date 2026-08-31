import type { KernelHarnessOwnershipRule } from "../types.js";

export function acpKernelOwnership(title: string): KernelHarnessOwnershipRule[] {
  return [
    {
      feature: "session",
      owner: "shared",
      appResponsibility: "Own OpenGrove session ids and persist the native ACP session binding.",
      kernelResponsibility: `Own ${title} session state and transcript semantics.`,
      adapterResponsibility: "Create or load the same ACP session instead of replaying Host history.",
    },
    {
      feature: "turn_lifecycle",
      owner: "adapter",
      adapterResponsibility:
        "Map session/prompt and session/update boundaries into one OpenGrove turn without flattening thought, tool, and answer channels.",
      kernelResponsibility: `Run the ${title} turn inside its native session.`,
    },
    {
      feature: "model_loop",
      owner: "kernel",
      kernelResponsibility: `${title} owns provider calls and its internal model/tool loop.`,
      adapterResponsibility: "Use ACP and do not reimplement the native loop.",
    },
    {
      feature: "native_tool_execution",
      owner: "kernel",
      kernelResponsibility: `Execute ${title} native tools and publish ACP tool lifecycle updates.`,
      adapterResponsibility:
        "Project structured tool_call/tool_call_update events without executing the tool a second time.",
    },
    {
      feature: "host_tool_execution",
      owner: "unsupported",
      notes: "The generic ACP bridge does not inject OpenGrove Host Tools.",
    },
    {
      feature: "approval",
      owner: "shared",
      appResponsibility: "Own approval UI, durable decisions, and access-mode policy.",
      kernelResponsibility: `Decide when a ${title} native action requests permission.`,
      adapterResponsibility: "Answer ACP session/request_permission in the same native turn.",
    },
    {
      feature: "user_question",
      owner: "unsupported",
      notes: "ACP does not currently expose a same-turn elicitation contract used by this bridge.",
    },
    {
      feature: "skill_discovery",
      owner: "shared",
      appResponsibility: "Own OpenGrove skill provenance and explicit publication records.",
      kernelResponsibility: `Discover SKILL.md from ${title}'s documented native project roots.`,
      adapterResponsibility:
        "Publish portable skills to the declared project root and keep Host skill bodies out of the prompt.",
    },
    {
      feature: "skill_loading",
      owner: "kernel",
      kernelResponsibility: `Load selected ${title} skills with native progressive-disclosure semantics.`,
      adapterResponsibility: "Use the kernel-specific invocation template instead of a generic prefix guess.",
    },
    {
      feature: "context_assembly",
      owner: "shared",
      appResponsibility: "Provide only explicit OpenGrove context and attachments.",
      kernelResponsibility: `Own ${title}'s native instructions, history, skills, tools, and compaction context.`,
      adapterResponsibility: "Send Host context as a distinct prompt section and never replay native-thread history.",
    },
    {
      feature: "knowledge_retrieval",
      owner: "unsupported",
      notes:
        "The generic ACP bridge has no certified native knowledge-retrieval projection; Kernel-native retrieval may still run internally.",
    },
    {
      feature: "artifact_extraction",
      owner: "unsupported",
      notes: "The generic ACP bridge has no certified native artifact projection yet.",
    },
    {
      feature: "memory_write",
      owner: "app",
      appResponsibility: "Own OpenGrove memory proposals, writes, feedback, and retention.",
    },
    {
      feature: "compaction",
      owner: "shared",
      appResponsibility: "Request compaction at the configured product threshold without trimming history.",
      kernelResponsibility: `Own ${title}'s native summarization and session rewrite.`,
      adapterResponsibility: "Call the documented kernel-native compaction surface and preserve its result.",
    },
    {
      feature: "auth",
      owner: "kernel",
      kernelResponsibility: `Own ${title}'s credential and provider authentication behavior.`,
      adapterResponsibility: "Pass the selected provider environment/config without logging secrets.",
    },
    {
      feature: "sandbox",
      owner: "shared",
      appResponsibility: "Choose the product access mode and answer permission requests.",
      kernelResponsibility: `Enforce ${title}'s native permission or sandbox behavior.`,
      adapterResponsibility:
        "Configure only documented native policy surfaces; do not claim an OS sandbox when none is exposed.",
    },
    {
      feature: "transport",
      owner: "adapter",
      nativeName: "Agent Client Protocol",
      adapterResponsibility: `Run ${title}'s ACP subprocess and preserve structured notifications and requests.`,
    },
    {
      feature: "trajectory",
      owner: "app",
      appResponsibility: "Persist normalized OpenGrove trajectory events.",
      adapterResponsibility: "Attach native session/tool ids when ACP exposes them.",
    },
    {
      feature: "diagnostics",
      owner: "shared",
      appResponsibility: "Expose redacted OpenGrove trajectory and capability evidence.",
      kernelResponsibility: `Own ${title}'s native logs and session diagnostics.`,
      adapterResponsibility:
        "Record bounded process/protocol diagnostics without private thought chunks or credentials.",
    },
  ];
}
