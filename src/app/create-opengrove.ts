import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_PRODUCT_NAME } from "../identity.js";
import {
  ApprovalInbox,
  ArtifactStore,
  CapabilityRegistry,
  ExecutionStore,
  EventLog,
  MemoryLedger,
  PackRegistry,
  QuestionInbox,
  RoutineRegistry,
  SessionStore,
  ToolRegistry,
  WorkingStateStore,
  createAssistantFinalEvent,
  type AgentCompactRequest,
  type AgentCompactResult,
  type AgentEvent,
  type AgentHostToolScope,
  type AgentSteerRequest,
  type AgentSteerResult,
  type AgentContext,
  type ActivitySpace,
  type AgentRuntime,
  type AgentSessionDeleteResult,
  type AgentSessionForkResult,
  type AgentSessionListResult,
  type AgentTurnRequest,
  type ContextEnvelope,
  type DynamicToolsMode,
  type InvokedSkillRecord,
  type LoadedSkill,
  type PolicyRule,
  type RequiredSkillRequirement,
  type ResponseSpeed,
  type RuntimeAccessMode,
  type SessionHistoryMode,
  type SkillCatalog,
  type SkillManifest,
  type UserLanguagePreference,
} from "../core.js";
import { createDefaultContextAssembler, type ContextAssembler } from "../context/context-assembler.js";
import type { BrowserPageReader, BrowserPageSnapshot } from "../environment/browser-adapter.js";
import {
  hasComputerState,
  normalizeComputerSnapshot,
  type ComputerStateReader,
  type ComputerStateSnapshot,
} from "../environment/computer-adapter.js";
import { createRequestChoicesTool } from "../tools/host-ui.js";
import { createAppImportTool, type AppImportContext } from "../tools/app-import.js";
import { createGroveGuideStatusTool, type GroveGuideStatusContext } from "../tools/grove-guide.js";
import { createRoomLedgerReadTool } from "../tools/rooms.js";
import { findDefaultAppGroupRoom } from "../server/app-room-ids.js";
import {
  createWorkflowCreateTool,
  dedupeRoutineSlug,
  writeRoutineFileToVault,
  type WorkflowCreateScope,
  type WorkflowCreateToolContext,
  type WorkflowFlowApproval,
  type WorkflowToolStepInput,
} from "../tools/workflow.js";
import { routineStepRoomId, validateRoutineToolInput } from "../routines/routine-step-validation.js";
import { createWorkflowActivateTool, type WorkflowActivateContext } from "../tools/workflow-activate.js";
import { createSkillInvokeTool } from "../tools/skill.js";
import { isBridgeKernelId, RoomChannelStore } from "../rooms/channel-store.js";
import { validateWorkflowMemberRef } from "../server/workflow-member-ref.js";
import { createPackRegistry } from "../packs/catalog.js";
import { createKernelRuntime, createRuntimeKernelAdapter } from "../kernel/adapter.js";
import { PI_KERNEL_CONTRACT } from "../kernel/adapters/pi.js";
import type { KernelAdapter } from "../kernel/types.js";
import { resolveSessionHistoryMode } from "../kernel/session-history-mode.js";
import { getKernelContract } from "../server/kernel-registry.js";
import { createKnowledgeBackedArtifactStore } from "../knowledge/artifact-view.js";
import { createKnowledgeBackedMemoryLedger } from "../knowledge/memory-view.js";
import { createKnowledgeFeedbackScorer, type KnowledgeFeedbackScorer } from "../knowledge/feedback-scorer.js";
import { createKnowledgeOrganizer, type KnowledgeOrganizer } from "../knowledge/organizer.js";
import { createKnowledgeSkillCatalogView, skillKnowledgeId } from "../knowledge/skill-view.js";
import { skillFileKnowledgeDocuments, skillTreeMetadata } from "./skill-tree.js";
import { createKnowledgeStore, type KnowledgeStore } from "../knowledge/store.js";
import { PiAgentRuntime, type PiAgentRuntimeOptions } from "../runtime/pi-runtime.js";
import { createSkillCatalog } from "../skills/catalog.js";
import { shouldExposeSkillTool } from "../skills/native-publisher.js";
import { clearActiveSkillState, createInvokedSkillRecord, recordInvokedSkill } from "../skills/runtime.js";

export interface OpenGroveApp {
  events: EventLog;
  approvals: ApprovalInbox;
  questions: QuestionInbox;
  capabilities: CapabilityRegistry;
  memory: MemoryLedger;
  artifacts: ArtifactStore;
  knowledge: KnowledgeStore;
  knowledgeOrganizer: KnowledgeOrganizer;
  knowledgeFeedbackScorer: KnowledgeFeedbackScorer;
  skills: SkillCatalog;
  packs: PackRegistry;
  sessions: SessionStore;
  executions: ExecutionStore;
  workingState: WorkingStateStore;
  routines: RoutineRegistry;
  rooms: RoomChannelStore;
  tools: ToolRegistry;
  recordEvent(event: AgentEvent, options?: RecordEventOptions): AgentEvent;
  runTurn(input: string, options?: AgentTurnOptions): AsyncIterable<AgentEvent>;
  steerTurn(input: AgentSteerRequest): Promise<AgentSteerResult>;
  compactSession(input: AgentCompactRequest): Promise<AgentCompactResult>;
  listKernelSessions(): Promise<AgentSessionListResult>;
  deleteKernelSession(sessionId: string): Promise<AgentSessionDeleteResult>;
  forkKernelSession(sourceSessionId: string, targetSessionId: string): Promise<AgentSessionForkResult>;
}

export interface AgentTurnOptions {
  sessionId?: string;
  runId?: string;
  requestedModelId?: string;
  requestedEffort?: string;
  requestedSkillName?: string;
  requestedSkillArgs?: string;
  /** Employee skill allow-list. Undefined means the full catalog; required skills are always included. */
  availableSkillNames?: string[];
  requiredSkillNames?: string[];
  /** Stable Host contract delivered through the kernel's session-instructions channel when supported. */
  sessionInstructions?: string;
  hostContextPromptBlock?: string;
  responseSpeed?: ResponseSpeed;
  budgetLimitUsd?: number;
  contextTokenBudget?: number;
  accessMode?: RuntimeAccessMode;
  planMode?: boolean;
  goalMode?: boolean;
  dynamicToolsMode?: DynamicToolsMode;
  sessionHistoryMode?: SessionHistoryMode;
  policy?: PolicyRule[];
  signal?: AbortSignal;
  runtimeEnv?: NodeJS.ProcessEnv;
  hostToolScope?: Omit<AgentHostToolScope, "sessionId">;
}

export interface RecordEventOptions {
  sessionId?: string;
  activity?: ActivitySpace;
  input?: string;
}

export interface CreateOpenGroveOptions {
  readPage: BrowserPageReader;
  readComputer?: ComputerStateReader;
  readReplyLanguagePreference?: () => UserLanguagePreference | undefined;
  createSession?: PiAgentRuntimeOptions["createSession"];
  runtime?: AgentRuntime;
  kernel?: KernelAdapter;
  assembleContext?: ContextAssembler;
  policy?: PolicyRule[];
  sessionId?: string;
  userId?: string;
  cwd?: string;
  workspaceRoot?: string;
  includeCodexSkills?: boolean;
  mountedApps?: Array<{ id?: string; path: string; enabled?: boolean; title?: string }>;
  groveGuide?: GroveGuideStatusContext;
  appImport?: AppImportContext;
  workflowCreateContext?: WorkflowCreateToolContext;
  workflowActivation?: WorkflowActivateContext;
  validateWorkflowFlowApproval?: (flowApproval: WorkflowFlowApproval, scope: WorkflowCreateScope) => string | undefined;
}

export function createOpenGrove(options: CreateOpenGroveOptions): OpenGroveApp {
  const workspaceRoot = options.workspaceRoot ?? options.cwd;
  const events = new EventLog();
  const approvals = new ApprovalInbox();
  const questions = new QuestionInbox();
  const capabilities = new CapabilityRegistry();
  const knowledge = createKnowledgeStore();
  const knowledgeOrganizer = createKnowledgeOrganizer({ store: knowledge });
  const knowledgeFeedbackScorer = createKnowledgeFeedbackScorer({ store: knowledge });
  const memory = createKnowledgeBackedMemoryLedger(knowledge);
  const artifacts = createKnowledgeBackedArtifactStore(knowledge);
  const baseSkills = createSkillCatalog({
    cwd: options.cwd,
    workspaceRoot,
    includeCodexSkills: options.includeCodexSkills === true,
    mountedApps: options.mountedApps,
  });
  const skills = createKnowledgeSkillCatalogView(baseSkills, knowledge, {
    extraMetadata(skill) {
      return {
        ...skillTreeMetadata(skill),
      };
    },
    extraDocuments: skillFileKnowledgeDocuments,
  });
  const packs = createPackRegistry({ cwd: options.cwd });
  const sessions = new SessionStore();
  const executions = new ExecutionStore();
  const workingState = new WorkingStateStore();
  const routines = new RoutineRegistry();
  const rooms = new RoomChannelStore();
  const tools = new ToolRegistry();
  if (shouldExposeSkillTool(options.kernel)) {
    tools.register(
      createSkillInvokeTool({
        id: "skill.invoke",
        title: "Invoke skill",
        description:
          "Load a skill by name with progressive disclosure. Returns the skill instructions for the next step instead of keeping every skill body in the base prompt.",
        activity: "local",
        risk: "read",
        input: {
          type: "json-schema",
          schema: {
            type: "object",
            required: ["skill"],
            properties: {
              skill: { type: "string" },
              args: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        permission: {
          mode: "allow",
          reason: "Loading a local skill is read-only.",
        },
      }),
    );
  }
  tools.register(
    createRoomLedgerReadTool(
      {
        id: "room.ledger.read",
        title: "读取房间账本",
        description:
          "读取当前获授权房间的可见消息；可以按关键词或消息序号分页，消息正文按原文返回，并用 sourceRoomId 标明实际房间。默认不返回成员资料；仅在需要核对当前成员状态时设置 includeMembers=true。附件不返回宿主机路径，过大的内联正文只保留元数据。",
        activity: "chat",
        risk: "read",
        input: {
          type: "json-schema",
          schema: {
            type: "object",
            properties: {
              roomId: {
                type: "string",
                description: "可选。房间 Run 已由 OpenGrove 绑定当前房间；在授权范围内传其他值不会切换房间。",
              },
              query: { type: "string", description: "可选。按消息正文、发送者或附件信息筛选。" },
              limit: { type: "number", description: "可选。最多返回多少条消息，范围 1 到 200。" },
              beforeSeq: { type: "number", description: "可选。只读取该 channelSeq 之前的消息。" },
              afterSeq: { type: "number", description: "可选。只读取该 channelSeq 之后的消息。" },
              includeMembers: {
                type: "boolean",
                description: "可选。设为 true 时附带当前成员的 id、名称和状态摘要；不会返回完整岗位、模型或内核配置。",
              },
            },
            additionalProperties: false,
          },
        },
        permission: {
          mode: "allow",
          reason: "Reading the local room ledger is read-only.",
        },
      },
      rooms,
    ),
  );
  tools.register(
    createAppImportTool(
      {
        id: "opengrove.app.import",
        title: "Import OpenGrove App",
        description:
          "Import, package when needed, mount, and live-refresh an App in the current local OpenGrove instance. Use this instead of editing bridge settings or guessing localhost ports.",
        activity: "local",
        risk: "write",
        input: {
          type: "json-schema",
          schema: {
            type: "object",
            required: ["source"],
            properties: {
              source: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              force: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        permission: {
          mode: "allow",
          reason: "App import writes only to the local OpenGrove App registry or managed App package directory.",
        },
      },
      {
        profile: options.appImport?.profile,
        workspaceRoot,
        cwd: options.cwd,
        mountedApps: options.appImport?.mountedApps ?? options.mountedApps,
        importApp: options.appImport?.importApp,
        language: () => options.readReplyLanguagePreference?.(),
      },
    ),
  );
  tools.register(
    createGroveGuideStatusTool(
      {
        id: "opengrove.guide.status",
        title: "Read OpenGrove guide status",
        description:
          "Return the local OpenGrove architecture and current workspace/App mounting state for Grove onboarding and troubleshooting.",
        activity: "chat",
        risk: "read",
        input: {
          type: "json-schema",
          schema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        permission: {
          mode: "allow",
          reason: "Reading OpenGrove guide status is read-only.",
        },
      },
      {
        profile: options.groveGuide?.profile,
        workspaceRoot,
        cwd: options.cwd,
        mountedApps: options.groveGuide?.mountedApps ?? options.mountedApps,
        language: () => options.readReplyLanguagePreference?.(),
      },
    ),
  );
  tools.register(
    createRequestChoicesTool(
      {
        id: "host.ui.requestChoices",
        title: "Request structured choices",
        description:
          "Legacy compatibility form for runtimes without a native user-question tool. The submitted choice arrives as the next user turn; kernels with native questions must use their native tool instead.",
        activity: "chat",
        risk: "read",
        input: {
          type: "json-schema",
          schema: {
            type: "object",
            required: ["questions"],
            properties: {
              formId: { type: "string" },
              title: { type: "string" },
              instructions: { type: "string" },
              submitLabel: { type: "string" },
              questions: {
                type: "array",
                items: {
                  type: "object",
                  required: ["prompt", "options"],
                  properties: {
                    id: { type: "string" },
                    prompt: { type: "string" },
                    options: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["label"],
                        properties: {
                          value: { type: "string" },
                          label: { type: "string" },
                          description: { type: "string" },
                        },
                        additionalProperties: false,
                      },
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        permission: {
          mode: "allow",
          reason: "Rendering a local choice form is read-only and does not send data externally.",
        },
      },
      { language: () => options.readReplyLanguagePreference?.() },
    ),
  );
  // workflow.create 宿主工具:给员工产出 P1 格式 .routine.md 文件。
  // activity=local / risk=write(只写工作区文件);permission allow。安全靠 F3 确定性高危校验 + §0 app wrapper。
  tools.register(
    createWorkflowCreateTool(
      {
        id: "workflow.create",
        title: "Create workflow",
        description:
          "Generate a routine workflow file (.routine.md) in the local knowledge vault's routines directory. " +
          "Validates member/tool targets. High-risk execution intents (e.g. drama-ops strategy-execute, ad creation, budget scaling) " +
          "require a preceding flowApproval step or generation is deterministically refused — engine approval is not a flow approval gate.",
        activity: "local",
        risk: "write",
        input: {
          type: "json-schema",
          schema: {
            type: "object",
            required: ["title", "steps"],
            properties: {
              appId: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              steps: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    toolId: { type: "string" },
                    memberId: { type: "string" },
                    roomId: { type: "string" },
                    prompt: { type: "string" },
                    input: {},
                    when: {
                      type: "object",
                      required: ["stepId"],
                      properties: {
                        stepId: { type: "string" },
                        path: { type: "string" },
                        operator: { type: "string", enum: ["truthy", "equals", "notEquals", "gt", "gte", "lt", "lte"] },
                        value: {},
                      },
                      additionalProperties: false,
                    },
                    approval: {
                      type: "object",
                      required: ["mode", "reason"],
                      properties: {
                        mode: { type: "string", enum: ["allow", "ask", "deny"] },
                        reason: { type: "string" },
                      },
                      additionalProperties: false,
                    },
                    flowApproval: {
                      type: "object",
                      required: ["flowId", "stepId"],
                      properties: {
                        flowId: { type: "string" },
                        stepId: { type: "string" },
                      },
                      additionalProperties: false,
                    },
                  },
                  additionalProperties: false,
                },
              },
              schedule: {
                type: "object",
                properties: {
                  at: { type: "string" },
                  everyMinutes: { type: "number" },
                  daysOfWeek: { type: "array", items: { type: "number" } },
                },
              },
              bodyMarkdown: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        permission: {
          mode: "allow",
          reason: "workflow.create only writes a routine file to the local knowledge vault.",
        },
      },
      options.workflowCreateContext ?? {
        validateMember(memberId, scope) {
          // R1:对齐 import route 的校验——不只查存在,还查可运行(runnable)且在当前范围。
          // 否则 workflow.create 能生成"用 disabled/不可运行/跨 app 成员"的 routine,导入/运行才失败。
          return validateWorkflowMemberRef(rooms, memberId, scope);
        },
        validateTool(toolId) {
          return tools.get(toolId) ? undefined : `tool_not_registered:${toolId}`;
        },
        prepareToolStep(step, scope) {
          return prepareRoutineToolStep(step, scope, (appId) => findDefaultAppGroupRoom(rooms.listRooms(), appId)?.id);
        },
        validateToolInput(step) {
          const inputError = validateRoutineToolInput(step);
          if (inputError) return inputError;
          if (step.toolId === "room.ledger.read") {
            const roomId = routineStepRoomId(step);
            if (roomId && !rooms.getRoom(roomId)) {
              return `tool_input_invalid:room.ledger.read:room_not_found:${roomId}`;
            }
          }
          return undefined;
        },
        validateFlowApproval(flowApproval, scope) {
          return options.validateWorkflowFlowApproval?.(flowApproval, scope);
        },
        writeRoutineDocument({ title, body }) {
          // RC2:先算出最终去重 slug,再创建 knowledge document,避免改 create() 返回的克隆视图。
          const slug = dedupeRoutineSlug(title);
          const document = knowledge.create({
            type: "routine",
            title,
            body,
            format: "markdown",
            metadata: { vaultPath: `OpenGrove/routines/${slug}.routine.md` },
          });
          writeRoutineFileToVault({ title, body, slug });
          return { knowledgeId: document.id };
        },
      },
    ),
  );
  if (options.workflowActivation) {
    tools.register(
      createWorkflowActivateTool(
        {
          id: "workflow.activate",
          title: "Activate workflow",
          description:
            "Import a generated routine workflow by knowledgeId, then run it after the user confirms. " +
            "Use this only after workflow.create produced a routine and host.ui.requestChoices confirmed the user wants to run it now.",
          activity: "local",
          risk: "write",
          input: {
            type: "json-schema",
            schema: {
              type: "object",
              required: ["knowledgeId"],
              properties: {
                knowledgeId: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          permission: {
            mode: "allow",
            reason: "workflow.activate imports and runs a local routine only after explicit user confirmation.",
          },
        },
        options.workflowActivation,
      ),
    );
  }

  const runtimeKernel = createRuntimeKernel(options);
  const runtime = createKernelRuntime(runtimeKernel);
  const assembleContext = options.assembleContext ?? createDefaultContextAssembler();

  const app: OpenGroveApp = {
    events,
    approvals,
    questions,
    capabilities,
    memory,
    artifacts,
    knowledge,
    knowledgeOrganizer,
    knowledgeFeedbackScorer,
    skills,
    packs,
    sessions,
    executions,
    workingState,
    routines,
    rooms,
    tools,
    recordEvent(event, recordOptions = {}) {
      const recorded = events.append(event);
      const fallbackSessionId = recordOptions.sessionId ?? workingState.get().sessionId ?? options.sessionId ?? "local";
      const run = sessions.recordEvent(recorded, {
        sessionId: fallbackSessionId,
        activity: recordOptions.activity,
        input: recordOptions.input,
      });
      executions.appendFromEvent(recorded, {
        sessionId: run?.sessionId ?? fallbackSessionId,
      });
      return recorded;
    },
    async steerTurn(input) {
      if (!runtime.steerTurn) {
        return { ok: false, guided: false, error: "steer_unavailable" };
      }
      return runtime.steerTurn(input);
    },
    async compactSession(input) {
      if (!runtime.compactSession) {
        return { ok: false, compacted: false, error: "compact_unavailable" };
      }
      const session = sessions.get(input.threadId);
      return runtime.compactSession({
        ...input,
        metadata: {
          ...(input.metadata ?? {}),
          ...(session?.metadata ? { sessionMetadata: session.metadata } : {}),
        },
      });
    },
    async listKernelSessions() {
      return (
        runtime.listSessions?.() ?? {
          ok: false,
          sessions: [],
          error: "session_list_unavailable",
        }
      );
    },
    async deleteKernelSession(sessionId) {
      return (
        runtime.deleteSession?.(sessionId) ?? {
          ok: false,
          deleted: false,
          error: "session_delete_unavailable",
        }
      );
    },
    async forkKernelSession(sourceSessionId, targetSessionId) {
      return (
        runtime.forkSession?.(sourceSessionId, targetSessionId) ?? {
          ok: false,
          forked: false,
          error: "session_fork_unavailable",
        }
      );
    },
    async *runTurn(input, turnOptions = {}) {
      const page = await options.readPage();
      const computer = await (options.readComputer?.() ?? Promise.resolve({} as ComputerStateSnapshot));
      const sessionId = turnOptions.sessionId ?? options.sessionId ?? "local";
      const activity: ActivitySpace = hasComputerState(computer) ? "computer" : "browser";
      const runId = turnOptions.runId ?? createRunId();
      const availableSkills = selectAvailableSkills(
        skills.list(),
        turnOptions.availableSkillNames,
        turnOptions.requiredSkillNames,
      );
      const discoveryPatch = {
        discoveredSkillIds: availableSkills.map((skill) => skill.id),
        discoveredSkillNames: availableSkills.map((skill) => skill.name),
      };
      const requiredSkillPreparation = prepareRequiredSkills(turnOptions.requiredSkillNames, skills, sessionId, {
        kernel: options.kernel,
        cwd: workspaceRoot,
      });
      const preparedInput = prepareTurnInput(input, {
        runId,
        sessionId,
        cwd: workspaceRoot,
        skills,
        workingState,
        kernel: options.kernel,
        requestedSkillName: turnOptions.requestedSkillName,
        requestedSkillArgs: turnOptions.requestedSkillArgs,
        planMode: turnOptions.planMode,
        goalMode: turnOptions.goalMode,
      });
      const context: AgentContext = {
        sessionId,
        userId: options.userId,
        activity,
        memory,
        artifacts,
        skills,
        packs,
        sessions,
        executions,
        workingState,
        approvals,
        questions,
        page: toAgentPageContext(page),
        computer: normalizeComputerSnapshot(computer),
      };
      const assembledContext = withRequiredSkillsPromptBlock(
        withHostContextPromptBlock(
          assembleContext(preparedInput.contextInput, context, {
            runId,
            kernelId: options.kernel?.id,
            kernelCapabilities: options.kernel?.capabilities,
          }),
          turnOptions.hostContextPromptBlock,
        ),
        requiredSkillPreparation.loadedSkills,
        requiredSkillPreparation.requirements,
      );
      recordRequestedSkillDelivery({
        knowledge,
        invocation: preparedInput.invocation,
        runId,
        sessionId,
        kernel: options.kernel,
      });
      recordRequiredSkillDeliveries({
        knowledge,
        loadedSkills: requiredSkillPreparation.loadedSkills,
        requirements: requiredSkillPreparation.requirements,
        runId,
        sessionId,
        kernel: options.kernel,
      });
      sessions.startRun({
        id: runId,
        sessionId,
        activity,
        input: preparedInput.originalInput,
      });

      let seededSkillEvents = false;
      let runPaused = false;
      const turnEvents: AgentEvent[] = [];
      for await (const event of runtime.runTurn({
        input: preparedInput.runtimeInput,
        runId,
        context,
        sessionInstructions: turnOptions.sessionInstructions,
        assembledContext,
        replyLanguagePreference: options.readReplyLanguagePreference?.(),
        requestedModelId: turnOptions.requestedModelId ?? preparedInput.requestedModelId,
        requestedEffort: turnOptions.requestedEffort ?? preparedInput.requestedEffort,
        responseSpeed: turnOptions.responseSpeed,
        budgetLimitUsd: turnOptions.budgetLimitUsd,
        contextTokenBudget: turnOptions.contextTokenBudget,
        threadGoal: preparedInput.threadGoal,
        accessMode: turnOptions.accessMode,
        dynamicToolsMode: turnOptions.dynamicToolsMode,
        sessionHistoryMode: resolveSessionHistoryMode(runtimeKernel.capabilities, turnOptions.sessionHistoryMode),
        requestedSkillInvocation: preparedInput.invocation,
        requiredSkills: requiredSkillPreparation.loadedSkills,
        requiredSkillRequirements: requiredSkillPreparation.requirements,
        signal: turnOptions.signal,
        tools: tools.list(),
        capabilities: capabilities.list(),
        skills: availableSkills,
        packs: packs.list(),
        policy: [...(options.policy ?? []), ...(turnOptions.policy ?? []), ...capabilities.policy()],
        runtimeEnv: turnOptions.runtimeEnv,
        hostToolScope: turnOptions.hostToolScope ? { sessionId, ...turnOptions.hostToolScope } : { sessionId },
      })) {
        if (event.type === "turn.finished") {
          const finalEvent = createAssistantFinalEvent(turnEvents, {
            runId,
            at: event.at,
            source: "fallback",
          });
          if (finalEvent) {
            turnEvents.push(finalEvent);
            app.recordEvent(finalEvent, {
              sessionId,
              activity,
              input: preparedInput.originalInput,
            });
            yield finalEvent;
          }
        }
        turnEvents.push(event);
        workingState.update({
          sessionId,
          ...discoveryPatch,
        });
        if (event.type === "skill.cleared") {
          workingState.update({
            ...clearActiveSkillState(workingState.get(), event.reason),
          });
        }
        if (event.type === "run.paused") {
          runPaused = true;
        }
        app.recordEvent(event, {
          sessionId,
          activity,
          input: preparedInput.originalInput,
        });
        yield event;
        if (!seededSkillEvents && event.type === "turn.started") {
          seededSkillEvents = true;
          if (availableSkills.length > 0) {
            const discovered: AgentEvent = {
              type: "skill.discovered",
              runId,
              skills: availableSkills,
            };
            app.recordEvent(discovered, {
              sessionId,
              activity,
              input: preparedInput.originalInput,
            });
            yield discovered;
          }
          for (const extra of preparedInput.prefixEvents) {
            app.recordEvent(extra, {
              sessionId,
              activity,
              input: preparedInput.originalInput,
            });
            yield extra;
          }
        }
        if (event.type === "compaction.started") {
          const record = memory.write({
            scope: "session",
            kind: "compaction_snapshot",
            text: createCompactionSnapshotText(preparedInput.originalInput, assembledContext),
            confidence: "observed",
            source: {
              kind: "agent",
              ref: {
                title: "Kernel compaction",
                locator: `run:${runId}`,
              },
            },
            tags: ["compaction", "context"],
            data: {
              runId,
              sessionId,
              ...(options.kernel?.id ? { kernelId: options.kernel.id } : {}),
            },
          });
          const memoryEvent: AgentEvent = { type: "memory.written", runId, record };
          app.recordEvent(memoryEvent, {
            sessionId,
            activity,
            input: preparedInput.originalInput,
          });
          yield memoryEvent;
        }
      }
      const trailingFinalEvent = createAssistantFinalEvent(turnEvents, {
        runId,
        source: "fallback",
      });
      if (trailingFinalEvent) {
        turnEvents.push(trailingFinalEvent);
        app.recordEvent(trailingFinalEvent, {
          sessionId,
          activity,
          input: preparedInput.originalInput,
        });
        yield trailingFinalEvent;
      }
      if (!runPaused) {
        const nextWorkingState = workingState.get();
        if (nextWorkingState.activeSkillId || nextWorkingState.activePackId) {
          workingState.update({
            ...clearActiveSkillState(nextWorkingState, "turn-complete"),
          });
        }
      }
    },
  };

  return app;
}

function prepareRoutineToolStep(
  step: WorkflowToolStepInput,
  scope: WorkflowCreateScope,
  resolveDefaultRoomId: (appId: string) => string | undefined,
): WorkflowToolStepInput {
  if (step.toolId !== "room.ledger.read" || !validateRoutineToolInput(step)) {
    return step;
  }
  const roomId = scope.appId ? resolveDefaultRoomId(scope.appId) : undefined;
  if (!roomId) {
    return step;
  }
  return {
    ...step,
    input: {
      ...recordInput(step.input),
      roomId,
    },
  };
}

function recordInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function createRuntimeKernel(options: CreateOpenGroveOptions): KernelAdapter {
  if (options.kernel) {
    return options.kernel;
  }
  if (options.runtime) {
    return createRuntimeKernelAdapter({
      id: "agent-runtime",
      title: "Agent Runtime",
      runtime: options.runtime,
    });
  }
  return createDefaultKernel(options);
}

function createDefaultKernel(options: CreateOpenGroveOptions): KernelAdapter {
  if (!options.createSession) {
    throw new Error("createOpenGrove requires either runtime or createSession.");
  }
  return createRuntimeKernelAdapter({
    id: "pi",
    title: "Pi",
    runtime: new PiAgentRuntime({
      createSession: options.createSession,
    }),
    capabilities: {
      sessionHistory: "kernel",
      reasoning: { nativeText: "conditional", summary: "unsupported" },
      streaming: false,
      toolCalls: true,
      hostTools: true,
      approvals: true,
      elicitation: false,
      artifacts: true,
      compaction: false,
      authRefresh: false,
      sandbox: ["danger-full-access"],
    },
    contract: PI_KERNEL_CONTRACT,
  });
}

function toAgentPageContext(page: BrowserPageSnapshot) {
  return {
    url: page.url,
    title: page.title,
    selection: page.selection,
    visibleText: page.visibleText,
    locator: page.locator,
    attachments: Array.isArray(page.attachments) ? page.attachments : [],
  };
}

function createRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function recordRequestedSkillDelivery(options: {
  knowledge: KnowledgeStore;
  invocation?: InvokedSkillRecord;
  runId: string;
  sessionId: string;
  kernel?: KernelAdapter;
}): void {
  const { invocation } = options;
  if (!invocation) {
    return;
  }

  const mode = options.kernel?.capabilities.knowledge?.nativeSkills ? "native_skill" : "loaded_skill";
  options.knowledge.recordDelivery({
    id: `skill_delivery_${options.runId}`,
    runId: options.runId,
    sessionId: options.sessionId,
    kernelId: options.kernel?.id,
    createdAt: new Date().toISOString(),
    query: invocation.args || invocation.skillName,
    decisions: [
      {
        knowledgeId: skillKnowledgeId(invocation.skillId),
        knowledgeType: "skill",
        title: invocation.title || invocation.skillName,
        mode,
        reason:
          mode === "native_skill"
            ? "Skill is available through the native kernel skill loader."
            : "Skill body is delivered through requestedSkillInvocation, not duplicated in assembled context.",
        score: 1,
        includeInPrompt: false,
        metadata: {
          skillId: invocation.skillId,
          skillName: invocation.skillName,
          origin: invocation.origin,
          source: invocation.source,
        },
      },
    ],
    metadata: {
      source: "requested_skill",
      promptItemCount: 0,
    },
  });
}

function prepareRequiredSkills(
  names: string[] | undefined,
  skills: SkillCatalog,
  sessionId: string,
  options: {
    kernel?: KernelAdapter;
    cwd?: string;
  },
): {
  loadedSkills: LoadedSkill[];
  requirements: RequiredSkillRequirement[];
} {
  const loadedSkills: LoadedSkill[] = [];
  const requirements: RequiredSkillRequirement[] = [];
  const seen = new Set<string>();
  for (const rawName of names ?? []) {
    const name = rawName.trim();
    if (!name) continue;
    const manifest = skills.resolve(name, { includeDisabled: true });
    if (!manifest) {
      if (seen.has(name)) continue;
      seen.add(name);
      requirements.push({
        configuredName: name,
        hostLoadStatus: "failed",
        hostLoadError: `required_skill_not_found:${name}`,
        modelLoadAllowed: true,
      });
      continue;
    }
    if (seen.has(manifest.id)) continue;
    seen.add(manifest.id);
    if (manifest.disableModelInvocation) {
      requirements.push({
        configuredName: name,
        manifest,
        sourcePath: manifest.entry,
        hostLoadStatus: "failed",
        hostLoadError: `required_skill_model_invocation_disabled:${manifest.name}`,
        modelLoadAllowed: false,
      });
      continue;
    }
    try {
      const loaded = skills.load(manifest.id, undefined, sessionId);
      if (options.kernel?.capabilities.knowledge?.nativeSkills === true) {
        requirements.push({
          configuredName: name,
          manifest,
          sourcePath: nativeSkillEntryPath(manifest, {
            kernelId: options.kernel.id,
            cwd: options.cwd,
          }),
          hostLoadStatus: "available",
          modelLoadAllowed: true,
        });
      } else {
        loadedSkills.push(loaded);
      }
    } catch (error) {
      requirements.push({
        configuredName: name,
        manifest,
        sourcePath: manifest.entry,
        hostLoadStatus: "failed",
        hostLoadError: error instanceof Error ? error.message : String(error),
        modelLoadAllowed: true,
      });
    }
  }
  return { loadedSkills, requirements };
}

function recordRequiredSkillDeliveries(options: {
  knowledge: KnowledgeStore;
  loadedSkills: LoadedSkill[];
  requirements: RequiredSkillRequirement[];
  runId: string;
  sessionId: string;
  kernel?: KernelAdapter;
}): void {
  if (!options.loadedSkills.length && !options.requirements.length) return;
  options.knowledge.recordDelivery({
    id: `required_skill_delivery_${options.runId}`,
    runId: options.runId,
    sessionId: options.sessionId,
    kernelId: options.kernel?.id,
    createdAt: new Date().toISOString(),
    query: [
      ...options.loadedSkills.map((skill) => skill.manifest.name),
      ...options.requirements.map((requirement) => requirement.manifest?.name ?? requirement.configuredName),
    ].join(", "),
    decisions: [
      ...options.loadedSkills.map((skill) => ({
        knowledgeId: skillKnowledgeId(skill.manifest.id),
        knowledgeType: "skill" as const,
        title: skill.manifest.title || skill.manifest.name,
        mode: "prompt_snippet" as const,
        reason: "The Kernel has no native Skill channel, so the Host injected the required entrypoint.",
        score: 1,
        includeInPrompt: true,
        characterCount: skill.content.length,
        metadata: {
          skillId: skill.manifest.id,
          skillName: skill.manifest.name,
          source: skill.manifest.source,
          sourcePath: skill.sourcePath,
          required: true,
          delivery: "host_prompt_fallback",
        },
      })),
      ...options.requirements.map((requirement) => ({
        knowledgeId: skillKnowledgeId(requirement.manifest?.id ?? requirement.configuredName),
        knowledgeType: "skill" as const,
        title: requirement.manifest?.title || requirement.manifest?.name || requirement.configuredName,
        mode: requirement.hostLoadStatus === "available" ? ("native_skill" as const) : ("skill_tool_hint" as const),
        reason:
          requirement.hostLoadStatus === "available"
            ? "Employee default Skill must be loaded through the Kernel native Skill channel."
            : "Host preflight failed; the requirement and diagnostic were passed to the model for native handling.",
        score: 1,
        includeInPrompt: true,
        metadata: {
          configuredName: requirement.configuredName,
          ...(requirement.manifest
            ? {
                skillId: requirement.manifest.id,
                skillName: requirement.manifest.name,
                source: requirement.manifest.source,
              }
            : {}),
          ...(requirement.sourcePath ? { sourcePath: requirement.sourcePath } : {}),
          hostLoadStatus: requirement.hostLoadStatus,
          ...(requirement.hostLoadError ? { hostLoadError: requirement.hostLoadError } : {}),
          modelLoadAllowed: requirement.modelLoadAllowed,
          required: true,
          delivery: "kernel_native_requirement",
        },
      })),
    ],
    metadata: {
      source: "required_employee_skills",
      promptItemCount: options.loadedSkills.length + options.requirements.length,
    },
  });
}

function prepareTurnInput(
  input: string,
  options: {
    runId: string;
    sessionId: string;
    cwd?: string;
    skills: SkillCatalog;
    workingState: WorkingStateStore;
    kernel?: KernelAdapter;
    requestedSkillName?: string;
    requestedSkillArgs?: string;
    planMode?: boolean;
    goalMode?: boolean;
  },
): {
  originalInput: string;
  contextInput: string;
  runtimeInput: string;
  requestedModelId?: string;
  requestedEffort?: string;
  threadGoal?: AgentTurnRequest["threadGoal"];
  invocation?: InvokedSkillRecord;
  prefixEvents: AgentEvent[];
} {
  const originalInput = input.trim();
  const currentWorkingState = options.workingState.get();
  const prefixEvents: AgentEvent[] = [];
  const requestedSkillName = options.requestedSkillName?.trim();

  if (requestedSkillName) {
    const manifest = options.skills.resolve(requestedSkillName, { includeDisabled: true });
    if (manifest) {
      const requestedSkillArgs = resolveRequestedSkillArgs({
        originalInput,
        requestedSkillName: manifest.name,
        requestedSkillArgs: options.requestedSkillArgs,
      });
      const useNativeSkill = options.kernel?.capabilities.knowledge?.nativeSkills === true;
      const invocation = useNativeSkill
        ? createNativeSkillInvocation(manifest, requestedSkillArgs, {
            kernelId: options.kernel?.id,
            cwd: options.cwd,
            kernel: options.kernel,
          })
        : createInvokedSkillRecord(options.skills.load(manifest.name, requestedSkillArgs, options.sessionId), "user");
      options.workingState.update({
        ...recordInvokedSkill(currentWorkingState, invocation),
      });
      prefixEvents.push({
        type: "skill.invoked",
        runId: options.runId,
        skill: manifest,
        invocation,
      });
      prefixEvents.push({
        type: "skill.loaded",
        runId: options.runId,
        skillId: manifest.id,
        contentPreview: invocation.contentPreview,
        allowedTools: [...manifest.allowedTools],
        model: manifest.model,
        effort: manifest.effort,
        context: manifest.context,
      });

      const runtimeInput = useNativeSkill
        ? nativeSkillRuntimeInput(options.kernel?.id, manifest.name, requestedSkillArgs, options.kernel)
        : requestedSkillArgs || `Use /${manifest.name} and continue with the loaded instructions.`;
      return {
        originalInput:
          originalInput || (requestedSkillArgs ? `/${manifest.name} ${requestedSkillArgs}` : `/${manifest.name}`),
        contextInput: requestedSkillArgs || manifest.whenToUse || manifest.description,
        runtimeInput,
        requestedModelId: manifest.model,
        requestedEffort: manifest.effort,
        invocation,
        prefixEvents,
      };
    }
  }

  options.workingState.update({
    ...clearActiveSkillState(currentWorkingState, "new-turn"),
  });
  return {
    originalInput,
    contextInput: originalInput,
    runtimeInput: modeRuntimeInput(options.kernel?.id, originalInput, {
      planMode: options.planMode,
      goalMode: options.goalMode,
      nativeGoalMode: supportsNativeThreadGoal(options.kernel),
      kernel: options.kernel,
    }),
    requestedModelId: undefined,
    requestedEffort: undefined,
    threadGoal: supportsNativeThreadGoal(options.kernel)
      ? {
          enabled: options.goalMode === true,
          objective: originalInput || undefined,
        }
      : undefined,
    invocation: undefined,
    prefixEvents,
  };
}

function modeRuntimeInput(
  kernelId: string | undefined,
  input: string,
  options: { planMode?: boolean; goalMode?: boolean; nativeGoalMode?: boolean; kernel?: KernelAdapter },
): string {
  const goalInput = options.goalMode && !options.nativeGoalMode ? goalModeRuntimeInput(input) : input;
  return options.planMode ? planModeRuntimeInput(kernelId, goalInput, options.kernel) : goalInput;
}

function supportsNativeThreadGoal(kernel: KernelAdapter | undefined): boolean {
  return kernel?.capabilities.nativeThreadGoal ?? false;
}

function goalModeRuntimeInput(input: string): string {
  const trimmed = input.trim();
  return trimmed
    ? `Treat this as a goal to pursue until it is clearly resolved. Keep progress oriented around the goal, ask only when blocked, and carry useful context forward:\n${trimmed}`
    : "Treat the next step as a goal to pursue until it is clearly resolved. Keep progress oriented around the goal, ask only when blocked, and carry useful context forward.";
}

function planModeRuntimeInput(kernelId: string | undefined, input: string, kernel?: KernelAdapter): string {
  const trimmed = input.trim();
  const contract = resolvedKernelContract(kernelId, kernel);
  const planMode = contract?.inputFormats.planMode;
  if (planMode) {
    return trimmed ? planMode.withInput.replace("{input}", trimmed) : planMode.withoutInput;
  }
  return trimmed
    ? `Create a plan first before taking action:\n${trimmed}`
    : "Create a plan first before taking action.";
}

function nativeSkillRuntimeInput(
  kernelId: string | undefined,
  skillName: string,
  args: string | undefined,
  kernel?: KernelAdapter,
): string {
  const contract = resolvedKernelContract(kernelId, kernel);
  const invocation = contract?.inputFormats.skillInvocation ?? {
    withArgs: "${name} {args}",
    withoutArgs: "${name}",
  };
  return (args ? invocation.withArgs : invocation.withoutArgs)
    .replaceAll("{name}", skillName)
    .replaceAll("{args}", args ?? "");
}

function resolveRequestedSkillArgs(options: {
  originalInput: string;
  requestedSkillName: string;
  requestedSkillArgs?: string;
}): string | undefined {
  if (options.requestedSkillArgs !== undefined) {
    return options.requestedSkillArgs.trim() || undefined;
  }

  const parsed = parseSkillSlashInput(options.originalInput);
  if (parsed?.skill === options.requestedSkillName) {
    return parsed.args;
  }

  if (options.originalInput && !options.originalInput.startsWith("/")) {
    return options.originalInput;
  }

  return undefined;
}

function createNativeSkillInvocation(
  manifest: NonNullable<ReturnType<SkillCatalog["resolve"]>>,
  args: string | undefined,
  options: { kernelId?: string; cwd?: string; kernel?: KernelAdapter },
): InvokedSkillRecord {
  const normalizedArgs = args?.trim() || undefined;
  return {
    skillId: manifest.id,
    skillName: manifest.name,
    title: manifest.title,
    content: "",
    contentPreview: `Native skill /${manifest.name} is published to the kernel skill directory; ${APP_PRODUCT_NAME} did not inject the skill body.`,
    sourcePath: nativeSkillEntryPath(manifest, options),
    source: manifest.source,
    trust: manifest.trust,
    context: manifest.context,
    args: normalizedArgs,
    allowedTools: [...manifest.allowedTools],
    model: manifest.model,
    effort: manifest.effort,
    packId: manifest.packId,
    capabilityId: manifest.capabilityId,
    invokedAt: new Date().toISOString(),
    origin: "user",
  };
}

function nativeSkillEntryPath(
  manifest: NonNullable<ReturnType<SkillCatalog["resolve"]>>,
  options: { kernelId?: string; cwd?: string; kernel?: KernelAdapter },
): string {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (isNativeSkillEntryForKernel(manifest.entry, options)) {
    return manifest.entry;
  }
  const projectSkillDir = resolvedKernelContract(options.kernelId, options.kernel)?.paths.projectSkillDir;
  if (projectSkillDir) {
    const target = join(cwd, projectSkillDir, manifest.name, "SKILL.md");
    return existsSync(target) ? target : manifest.entry;
  }
  return manifest.entry;
}

function isNativeSkillEntryForKernel(entry: string, options: { kernelId?: string; kernel?: KernelAdapter }): boolean {
  const normalized = entry.replace(/\\/g, "/");
  const contract = resolvedKernelContract(options.kernelId, options.kernel);
  const marker = contract?.paths.nativeSkillMarker;
  if (marker) return normalized.includes(marker);
  return false;
}

function resolvedKernelContract(
  kernelId: string | undefined,
  kernel?: KernelAdapter,
): KernelAdapter["contract"] | undefined {
  if (kernel?.contract && kernel.contractOrigin !== "generated") return kernel.contract;
  if (kernelId && isBridgeKernelId(kernelId)) return getKernelContract(kernelId);
  return kernel?.contract;
}

function createCompactionSnapshotText(input: string, context: { summary?: string; promptBlock?: string }): string {
  const sections = [
    `User request before compaction:\n${input}`,
    context.summary ? `Context summary:\n${context.summary}` : "",
    context.promptBlock ? `Host context snapshot:\n${truncateContextSnapshot(context.promptBlock)}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

function withHostContextPromptBlock(context: ContextEnvelope, hostContextPromptBlock?: string): ContextEnvelope {
  const hostBlock = hostContextPromptBlock?.trim();
  if (!hostBlock) return context;
  const existingPromptBlock = context.promptBlock.trim();
  return {
    ...context,
    summary: context.summary === "empty context" ? "host context" : `host context, ${context.summary}`,
    budget: {
      ...context.budget,
      usedCharacters: context.budget.usedCharacters + hostBlock.length,
    },
    promptBlock: [hostBlock, existingPromptBlock].filter(Boolean).join("\n\n"),
  };
}

function withRequiredSkillsPromptBlock(
  context: ContextEnvelope,
  loadedSkills: LoadedSkill[],
  requirements: RequiredSkillRequirement[],
): ContextEnvelope {
  if (!loadedSkills.length && !requirements.length) return context;
  const requiredBlock = [
    "OpenGrove required employee skills:",
    loadedSkills.length
      ? "This Kernel has no native Skill channel. The Host loaded the following mandatory entrypoints as a compatibility fallback."
      : "",
    ...loadedSkills.map((skill) =>
      [
        `## Required skill: ${skill.manifest.name}`,
        `Skill id: ${skill.manifest.id}`,
        `Source path: ${skill.sourcePath}`,
        skill.manifest.allowedTools.length ? `Declared tool scope: ${skill.manifest.allowedTools.join(", ")}` : "",
        skill.content,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    requirements.length
      ? "The Host did not inject the following Skill bodies. They are mandatory for this Employee: load them before acting through the Kernel's native Skill support or by reading the exact SKILL.md path. Host preflight status is diagnostic context for the model."
      : "",
    ...requirements.map((requirement) =>
      [
        `## Required skill: ${requirement.manifest?.name ?? requirement.configuredName}`,
        `Configured name: ${requirement.configuredName}`,
        requirement.manifest ? `Skill id: ${requirement.manifest.id}` : "",
        requirement.manifest?.description ? `Description: ${requirement.manifest.description}` : "",
        requirement.sourcePath ? `SKILL.md: ${requirement.sourcePath}` : "",
        `Host preflight: ${requirement.hostLoadStatus}`,
        requirement.hostLoadError ? `Host preflight detail: ${requirement.hostLoadError}` : "",
        requirement.modelLoadAllowed
          ? "Load this Skill before acting. If loading still fails, do not continue without it; report the failure yourself."
          : "Host policy does not allow this Skill to be loaded by the model. Do not continue as if it were loaded; handle the failure yourself.",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n\n");
  return {
    ...context,
    summary:
      context.summary === "empty context" ? "required employee skills" : `required employee skills, ${context.summary}`,
    budget: {
      ...context.budget,
      usedCharacters: context.budget.usedCharacters + requiredBlock.length,
    },
    promptBlock: [requiredBlock, context.promptBlock].filter(Boolean).join("\n\n"),
  };
}

function truncateContextSnapshot(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 4_000 ? `${trimmed.slice(0, 4_000)}\n...` : trimmed;
}

function parseSkillSlashInput(input: string): { skill: string; args?: string } | undefined {
  if (!input.startsWith("/")) {
    return undefined;
  }

  const trimmed = input.slice(1).trim();
  if (!trimmed) {
    return undefined;
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace < 0) {
    return {
      skill: trimmed,
    };
  }

  return {
    skill: trimmed.slice(0, firstSpace),
    args: trimmed.slice(firstSpace + 1).trim() || undefined,
  };
}

function selectAvailableSkills(
  catalog: SkillManifest[],
  availableNames: string[] | undefined,
  requiredNames: string[] | undefined,
): SkillManifest[] {
  const modelInvocable = catalog.filter((skill) => !skill.disableModelInvocation);
  if (availableNames === undefined) return modelInvocable;
  const selected = new Set([...availableNames, ...(requiredNames ?? [])].map((value) => value.trim()).filter(Boolean));
  return modelInvocable.filter(
    (skill) =>
      selected.has(skill.id) || selected.has(skill.name) || (skill.aliases ?? []).some((alias) => selected.has(alias)),
  );
}
