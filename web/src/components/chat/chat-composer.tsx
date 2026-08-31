import {
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import clsx from "clsx";
import {
  ArrowUp,
  ArrowDown,
  CircleDollarSign,
  ClipboardPlus,
  CornerDownRight,
  FileText,
  Image as ImageIcon,
  ListChecks,
  Hand,
  TerminalSquare,
  AlertTriangle,
  Square,
  Target,
  Zap,
} from "lucide-react";
import type {
  AttachmentPayload,
  ContextArtifactPayload,
  ModelId,
  ReasoningEffort,
  ResponseSpeed,
  RuntimeControls,
  RuntimeAccessMode,
} from "../../bridge";
import { clamp, summarize } from "../../format";
import { useI18n, type TranslationFn } from "../../i18n";
import { ProductIcon } from "../ui/product-icon";
import { MotionPopover } from "../ui/motion/popover";
import { MotionMenu, MotionMenuItem } from "../ui/motion/menu";
import { modelLabel, modelOptionMatchesId, modelOptionsForKernel } from "../../runtime/kernel-models";
import {
  MAX_COMPOSER_HEIGHT,
  MIN_COMPOSER_HEIGHT,
  attachmentImagePreviewUrl,
  attachmentIcon,
  formatAttachmentMeta,
  formatComposerSkillTitle,
  type ComposerSkillInvocation,
  type ContextUsage,
} from "../../runtime/ui-model";
import "./opengrove-composer.css";
import "../shared/attachments.css";
import styles from "./chat-composer.module.css";

const ACCESS_PRESETS: Array<{
  id: RuntimeAccessMode;
  labelKey: "composer.defaultAccess" | "composer.autoReview" | "composer.fullAccess";
  descriptionKey:
    | "composer.defaultAccessDescription"
    | "composer.autoReviewDescription"
    | "composer.fullAccessDescription";
  icon: typeof Hand;
  danger?: boolean;
}> = [
  {
    id: "default",
    labelKey: "composer.defaultAccess",
    descriptionKey: "composer.defaultAccessDescription",
    icon: Hand,
  },
  {
    id: "auto-review",
    labelKey: "composer.autoReview",
    descriptionKey: "composer.autoReviewDescription",
    icon: TerminalSquare,
  },
  {
    id: "full-access",
    labelKey: "composer.fullAccess",
    descriptionKey: "composer.fullAccessDescription",
    icon: AlertTriangle,
    danger: true,
  },
];

const EFFORT_OPTIONS: Array<{
  id: ReasoningEffort;
  labelKey:
    | "composer.effortLow"
    | "composer.effortMedium"
    | "composer.effortHigh"
    | "composer.effortXHigh"
    | "composer.effortMax";
}> = [
  { id: "low", labelKey: "composer.effortLow" },
  { id: "medium", labelKey: "composer.effortMedium" },
  { id: "high", labelKey: "composer.effortHigh" },
  { id: "xhigh", labelKey: "composer.effortXHigh" },
  { id: "max", labelKey: "composer.effortMax" },
];

const SPEED_OPTIONS: Array<{
  id: ResponseSpeed;
  labelKey: "composer.speedStandard" | "composer.speedFast";
  descriptionKey: "composer.speedStandardDescription" | "composer.speedFastDescription";
}> = [
  { id: "standard", labelKey: "composer.speedStandard", descriptionKey: "composer.speedStandardDescription" },
  { id: "fast", labelKey: "composer.speedFast", descriptionKey: "composer.speedFastDescription" },
];

const BUDGET_OPTIONS: Array<{
  value: number | null;
  labelKey: "composer.budgetOff" | "composer.budgetQuarter" | "composer.budgetOne" | "composer.budgetFive";
  descriptionKey: "composer.budgetOffDescription" | "composer.budgetHardLimitDescription";
}> = [
  { value: null, labelKey: "composer.budgetOff", descriptionKey: "composer.budgetOffDescription" },
  { value: 0.25, labelKey: "composer.budgetQuarter", descriptionKey: "composer.budgetHardLimitDescription" },
  { value: 1, labelKey: "composer.budgetOne", descriptionKey: "composer.budgetHardLimitDescription" },
  { value: 5, labelKey: "composer.budgetFive", descriptionKey: "composer.budgetHardLimitDescription" },
];

export type ComposerMenuKind = "add" | "access" | "model";

type ComposerEffortOption = { id: ReasoningEffort; label: string; description?: string };
type ComposerSpeedOption = { id: ResponseSpeed; label: string; description?: string };

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function isResponseSpeed(value: string): value is ResponseSpeed {
  return value === "standard" || value === "fast";
}

export { modelOptionsForKernel };

function effortOptionsForRuntime(t: TranslationFn, runtimeControls?: RuntimeControls): ComposerEffortOption[] {
  const localized = new Map(EFFORT_OPTIONS.map((item) => [item.id, { id: item.id, label: t(item.labelKey) }]));
  const discovered = runtimeControls?.reasoningEfforts
    ?.filter((item): item is ComposerEffortOption => isReasoningEffort(item.id))
    .map((item) => localized.get(item.id)!);
  return discovered?.length ? discovered : [...localized.values()];
}

function speedOptionsForRuntime(t: TranslationFn, runtimeControls?: RuntimeControls): ComposerSpeedOption[] {
  const localized = new Map(
    SPEED_OPTIONS.map((item) => [
      item.id,
      {
        id: item.id,
        label: t(item.labelKey),
        description: t(item.descriptionKey),
      },
    ]),
  );
  const discovered = runtimeControls?.speedTiers
    ?.filter((item): item is ComposerSpeedOption => isResponseSpeed(item.id))
    .map((item) => localized.get(item.id)!);
  return discovered?.length ? discovered : [...localized.values()];
}

export interface ChatComposerProps {
  sending: boolean;
  unavailableReason?: string;
  contextText: string;
  attachments: AttachmentPayload[];
  contextArtifacts: ContextArtifactPayload[];
  composerSkillInvocation: ComposerSkillInvocation | null;
  composerQuestionValue: string;
  composerHeight: number;
  model: ModelId;
  activeKernel?: string;
  runtimeControls?: RuntimeControls;
  contextUsage?: ContextUsage;
  effort: ReasoningEffort;
  responseSpeed: ResponseSpeed;
  budgetLimitUsd: number | null;
  accessMode: RuntimeAccessMode;
  modelMenuKind: ComposerMenuKind | null;
  modelMenuPlacement: "up" | "down";
  planMode: boolean;
  goalMode: boolean;
  canShowPlanMode: boolean;
  canShowGoalMode: boolean;
  canShowReasoningControls: boolean;
  canShowSpeedControls: boolean;
  canShowBudgetControls: boolean;
  canGuideQueuedInstruction: boolean;
  queuedInstructions?: Array<{
    id: string;
    prompt: string;
    status?: "queued" | "guiding" | "guide-failed";
    lastError?: string;
  }>;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  modelMenuRef: RefObject<HTMLDivElement | null>;
  onPointerDown(event: PointerEvent<HTMLDivElement>): void;
  onClearContext(): void;
  onRemoveContextArtifact(artifactId: string): void;
  onRemoveAttachment(attachmentId: string): void;
  onQuestionChange(value: string): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  onAttachmentInputChange(event: ChangeEvent<HTMLInputElement>): void;
  onOpenAttachmentPicker(event?: MouseEvent<HTMLButtonElement>): void;
  onToggleModelMenu(kind: ComposerMenuKind): void;
  onTogglePlanMode(): void;
  onToggleGoalMode(): void;
  onGuideQueuedInstruction(id: string): void;
  onRemoveQueuedInstruction(id: string): void;
  onUpdateQueuedInstruction(id: string, prompt: string): void;
  onMoveQueuedInstruction(id: string, direction: "up" | "down"): void;
  onSubmitQueuedInstructionNow(id: string): void;
  onSetModel(model: ModelId): void;
  onSetEffort(effort: ReasoningEffort): void;
  onSetResponseSpeed(speed: ResponseSpeed): void;
  onSetBudgetLimitUsd(value: number | null): void;
  onSetAccessMode(mode: RuntimeAccessMode): void;
  onSubmitOrStop(): void;
  onRemoveSkillInvocation(): void;
  voiceInput?: {
    state: "idle" | "recording" | "transcribing";
    disabled?: boolean;
    error?: string;
    onToggle(): void;
  };
  skillMenu?: ReactNode;
  onSkillMenuOpenChange?(open: boolean): void;
}

export function ChatComposer(props: ChatComposerProps) {
  const { t } = useI18n();
  const unavailable = Boolean(props.unavailableReason) && !props.sending;
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  return (
    <section className={styles.region} aria-label={t("composer.placeholder")}>
      <MotionPopover
        open={Boolean(props.skillMenu)}
        onOpenChange={(open) => props.onSkillMenuOpenChange?.(open)}
        anchorRef={composerAnchorRef}
        side="top"
        sideOffset={8}
        align="center"
        className="skill-menu"
        role="dialog"
        ariaLabel={t("composer.skills")}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && composerAnchorRef.current?.contains(target)) {
            event.preventDefault();
          }
        }}
      >
        {props.skillMenu}
      </MotionPopover>
      {props.queuedInstructions?.length ? (
        <QueuedInstructionList
          items={props.queuedInstructions}
          canGuide={props.canGuideQueuedInstruction}
          canSubmitNow={!unavailable && (!props.sending || props.canGuideQueuedInstruction)}
          onGuide={props.onGuideQueuedInstruction}
          onRemove={props.onRemoveQueuedInstruction}
          onUpdate={props.onUpdateQueuedInstruction}
          onMove={props.onMoveQueuedInstruction}
          onSubmitNow={props.onSubmitQueuedInstructionNow}
        />
      ) : null}

      <div
        ref={composerAnchorRef}
        className={clsx("opengrove-composer", styles.composer)}
        data-sending={props.sending ? "true" : "false"}
        data-skill={props.composerSkillInvocation ? "true" : "false"}
        onPointerDown={props.onPointerDown}
      >
        <div
          className={clsx("opengrove-composer-resize-handle", styles.resizeHandle)}
          data-action="resize-composer"
        ></div>

        {props.contextText || props.attachments.length || props.contextArtifacts.length ? (
          <ComposerAttachmentBar
            contextText={props.contextText}
            attachments={props.attachments}
            contextArtifacts={props.contextArtifacts}
            onClearContext={props.onClearContext}
            onRemoveAttachment={props.onRemoveAttachment}
            onRemoveContextArtifact={props.onRemoveContextArtifact}
          />
        ) : null}

        <div
          className={clsx("opengrove-question-line", styles.questionLine)}
          data-skill={props.composerSkillInvocation ? "true" : "false"}
        >
          {props.composerSkillInvocation ? (
            <button
              className={clsx("opengrove-skill-chip", styles.skillChip)}
              type="button"
              onClick={props.onRemoveSkillInvocation}
              aria-label={t("composer.removeSkill", {
                name: formatComposerSkillTitle(props.composerSkillInvocation.skill),
              })}
              title={`/${props.composerSkillInvocation.name}`}
            >
              <ProductIcon name="package" size={15} />
              <span>{formatComposerSkillTitle(props.composerSkillInvocation.skill)}</span>
            </button>
          ) : null}

          <textarea
            ref={props.composerInputRef}
            className={clsx("opengrove-question", styles.question)}
            rows={3}
            value={props.composerQuestionValue}
            placeholder={props.composerSkillInvocation ? t("composer.skillPlaceholder") : t("composer.placeholder")}
            aria-expanded={Boolean(props.skillMenu)}
            aria-haspopup="dialog"
            spellCheck={false}
            disabled={unavailable}
            onChange={(event) => props.onQuestionChange(event.target.value)}
            onKeyDown={props.onKeyDown}
            onPaste={props.onPaste}
            onCompositionStart={props.onCompositionStart}
            onCompositionEnd={props.onCompositionEnd}
            style={{ height: `${clamp(props.composerHeight, MIN_COMPOSER_HEIGHT, MAX_COMPOSER_HEIGHT)}px` }}
          ></textarea>
        </div>

        {unavailable ? (
          <div className={styles.unavailableReason} role="status">
            {props.unavailableReason}
          </div>
        ) : null}

        <div className={clsx("opengrove-composer-footer", styles.footer)} ref={props.modelMenuRef}>
          <div className={clsx("opengrove-composer-footer-left", styles.footerLeft)}>
            <input
              ref={props.fileInputRef}
              className={clsx("opengrove-file-input", styles.fileInput)}
              type="file"
              multiple
              onChange={props.onAttachmentInputChange}
            />
            <ComposerAddMenu
              open={props.modelMenuKind === "add"}
              placement={props.modelMenuPlacement}
              planMode={props.planMode}
              goalMode={props.goalMode}
              canShowPlanMode={props.canShowPlanMode}
              canShowGoalMode={props.canShowGoalMode}
              onToggle={() => props.onToggleModelMenu("add")}
              onOpenAttachmentPicker={props.onOpenAttachmentPicker}
              onTogglePlanMode={props.onTogglePlanMode}
              onToggleGoalMode={props.onToggleGoalMode}
            />
            <div className={clsx("opengrove-composer-controls", styles.controls)}>
              <ComposerAccessPicker
                accessMode={props.accessMode}
                open={props.modelMenuKind === "access"}
                placement={props.modelMenuPlacement}
                onToggle={() => props.onToggleModelMenu("access")}
                onSetAccessMode={props.onSetAccessMode}
              />
              {props.canShowPlanMode && props.planMode ? (
                <button
                  className={clsx("opengrove-model-button", styles.modelButton, styles.planChip)}
                  type="button"
                  onClick={props.onTogglePlanMode}
                  aria-label={t("composer.disablePlanMode")}
                  title={t("composer.disablePlanMode")}
                >
                  <ProductIcon name="close" size={13} />
                  <span>{t("composer.planModeShort")}</span>
                </button>
              ) : null}
              {props.canShowGoalMode && props.goalMode ? (
                <button
                  className={clsx("opengrove-model-button", styles.modelButton, styles.planChip)}
                  type="button"
                  onClick={props.onToggleGoalMode}
                  aria-label={t("composer.disableGoalMode")}
                  title={t("composer.disableGoalMode")}
                >
                  <ProductIcon name="close" size={13} />
                  <span>{t("composer.goalModeShort")}</span>
                </button>
              ) : null}
            </div>
          </div>
          <div className={clsx("opengrove-composer-footer-right", styles.footerRight)}>
            {props.voiceInput ? (
              <button
                className={clsx(
                  "opengrove-action opengrove-composer-plus opengrove-composer-mic",
                  styles.actionButton,
                  styles.plusButton,
                  styles.micButton,
                )}
                data-state={props.voiceInput.state}
                type="button"
                disabled={props.voiceInput.disabled || props.voiceInput.state === "transcribing"}
                onClick={props.voiceInput.onToggle}
                aria-label={
                  props.voiceInput.state === "recording"
                    ? t("composer.voiceStop")
                    : props.voiceInput.state === "transcribing"
                      ? t("composer.voiceTranscribing")
                      : t("composer.voiceStart")
                }
                title={
                  props.voiceInput.error ||
                  (props.voiceInput.state === "recording"
                    ? t("composer.voiceStop")
                    : props.voiceInput.state === "transcribing"
                      ? t("composer.voiceTranscribing")
                      : t("composer.voiceStart"))
                }
              >
                {props.voiceInput.state === "recording" ? <Square size={14} /> : <ProductIcon name="voice" size={18} />}
              </button>
            ) : null}
            <ComposerModelPicker
              model={props.model}
              activeKernel={props.activeKernel}
              runtimeControls={props.runtimeControls}
              effort={props.effort}
              responseSpeed={props.responseSpeed}
              budgetLimitUsd={props.budgetLimitUsd}
              canShowReasoningControls={props.canShowReasoningControls}
              canShowSpeedControls={props.canShowSpeedControls}
              canShowBudgetControls={props.canShowBudgetControls}
              open={props.modelMenuKind === "model"}
              placement={props.modelMenuPlacement}
              onToggle={() => props.onToggleModelMenu("model")}
              onSetModel={props.onSetModel}
              onSetEffort={props.onSetEffort}
              onSetResponseSpeed={props.onSetResponseSpeed}
              onSetBudgetLimitUsd={props.onSetBudgetLimitUsd}
            />
            {props.contextUsage ? <ContextWindowRing usage={props.contextUsage} /> : null}
            <button
              className={clsx(
                "opengrove-action opengrove-primary opengrove-send",
                styles.actionButton,
                styles.sendButton,
              )}
              type="button"
              disabled={unavailable}
              onClick={props.onSubmitOrStop}
              aria-label={props.sending ? t("composer.stop") : t("composer.send")}
              title={props.sending ? t("composer.stop") : props.unavailableReason || t("composer.send")}
            >
              {props.sending ? (
                <Square size={13} fill="currentColor" strokeWidth={0} />
              ) : (
                <ProductIcon name="send" size={18} />
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function QueuedInstructionList(props: {
  items: NonNullable<ChatComposerProps["queuedInstructions"]>;
  canGuide: boolean;
  canSubmitNow: boolean;
  onGuide(id: string): void;
  onRemove(id: string): void;
  onUpdate(id: string, prompt: string): void;
  onMove(id: string, direction: "up" | "down"): void;
  onSubmitNow(id: string): void;
}) {
  const { t } = useI18n();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const startEditing = (item: NonNullable<ChatComposerProps["queuedInstructions"]>[number]) => {
    setEditingId(item.id);
    setDraft(item.prompt);
    setOpenMenuId(null);
  };
  const saveEditing = () => {
    if (!editingId) return;
    props.onUpdate(editingId, draft);
    setEditingId(null);
    setDraft("");
  };
  return (
    <div className={styles.queuedList} aria-label={t("composer.queuedInstructions")}>
      {props.items.map((item, index) => (
        <div className={styles.queuedItem} key={item.id} data-status={item.status || "queued"}>
          <CornerDownRight size={15} strokeWidth={2.1} aria-hidden="true" />
          {editingId === item.id ? (
            <div className={styles.queuedEdit}>
              <input
                className={styles.queuedEditInput}
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveEditing();
                  }
                  if (event.key === "Escape") {
                    setEditingId(null);
                    setDraft("");
                  }
                }}
                aria-label={t("composer.editQueuedInstruction")}
              />
              <button
                className={clsx(styles.actionButton, styles.iconButton, styles.queuedEditButton)}
                type="button"
                onClick={saveEditing}
                aria-label={t("composer.saveQueuedInstruction")}
                title={t("composer.saveQueuedInstruction")}
              >
                <ProductIcon name="check" size={14} />
              </button>
              <button
                className={clsx(styles.actionButton, styles.iconButton, styles.queuedEditButton)}
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setDraft("");
                }}
                aria-label={t("composer.cancelQueuedInstruction")}
                title={t("composer.cancelQueuedInstruction")}
              >
                <ProductIcon name="close" size={14} />
              </button>
            </div>
          ) : (
            <span className={styles.queuedText}>{item.prompt}</span>
          )}
          <button
            className={clsx(styles.queuedGuideButton, styles.actionButton)}
            type="button"
            disabled={!props.canGuide || item.status === "guiding"}
            onClick={() => props.onGuide(item.id)}
            title={props.canGuide ? t("composer.guide") : t("composer.guideUnavailable")}
          >
            <CornerDownRight size={14} strokeWidth={2.1} aria-hidden="true" />
            <span>{item.status === "guiding" ? t("composer.guiding") : t("composer.guide")}</span>
          </button>
          {item.status === "guide-failed" ? (
            <div className={styles.queuedError} role="status">
              <ProductIcon name="warning" size={13} />
              <span>{t("composer.guideFailedDetail", { reason: item.lastError || t("composer.guideFailed") })}</span>
            </div>
          ) : null}
          <button
            className={clsx(styles.actionButton, styles.iconButton, styles.queuedRemoveButton)}
            type="button"
            onClick={() => props.onRemove(item.id)}
            aria-label={t("composer.removeQueuedInstruction")}
            title={t("composer.removeQueuedInstruction")}
          >
            <ProductIcon name="delete" size={14} />
          </button>
          <MotionMenu
            open={openMenuId === item.id}
            onOpenChange={(open) => setOpenMenuId(open ? item.id : null)}
            align="end"
            className={styles.queuedOverflowMenu}
            ariaLabel={t("composer.moreQueuedInstructionActions")}
            tooltipContent={t("composer.moreQueuedInstructionActions")}
            trigger={
              <button
                className={clsx(styles.actionButton, styles.iconButton, styles.queuedMoreButton)}
                type="button"
                aria-label={t("composer.moreQueuedInstructionActions")}
              >
                <ProductIcon name="more" size={15} />
              </button>
            }
          >
            <MotionMenuItem onClick={() => startEditing(item)}>
              <ProductIcon name="edit" size={14} />
              <span>{t("composer.editQueuedInstruction")}</span>
            </MotionMenuItem>
            <MotionMenuItem
              disabled={index === 0}
              onClick={() => {
                props.onMove(item.id, "up");
              }}
            >
              <ArrowUp size={14} strokeWidth={2.1} />
              <span>{t("composer.moveQueuedInstructionUp")}</span>
            </MotionMenuItem>
            <MotionMenuItem
              disabled={index === props.items.length - 1}
              onClick={() => {
                props.onMove(item.id, "down");
              }}
            >
              <ArrowDown size={14} strokeWidth={2.1} />
              <span>{t("composer.moveQueuedInstructionDown")}</span>
            </MotionMenuItem>
            <MotionMenuItem
              disabled={!props.canSubmitNow || item.status === "guiding"}
              title={
                props.canSubmitNow
                  ? t("composer.submitQueuedInstructionNow")
                  : t("composer.submitQueuedInstructionNowUnavailable")
              }
              onClick={() => {
                props.onSubmitNow(item.id);
              }}
            >
              <ProductIcon name="send" size={14} />
              <span>{t("composer.submitQueuedInstructionNow")}</span>
            </MotionMenuItem>
          </MotionMenu>
        </div>
      ))}
    </div>
  );
}

function ComposerAddMenu(props: {
  open: boolean;
  placement: "up" | "down";
  planMode: boolean;
  goalMode: boolean;
  canShowPlanMode: boolean;
  canShowGoalMode: boolean;
  onToggle(): void;
  onOpenAttachmentPicker(event?: MouseEvent<HTMLButtonElement>): void;
  onTogglePlanMode(): void;
  onToggleGoalMode(): void;
}) {
  const { t } = useI18n();
  return (
    <div className={clsx("opengrove-model-picker", styles.modelPicker)}>
      <MotionPopover
        open={props.open}
        onOpenChange={(open) => {
          if (open !== props.open) props.onToggle();
        }}
        side={props.placement === "up" ? "top" : "bottom"}
        align="start"
        size="content"
        className={clsx("opengrove-model-menu", styles.menu, styles.addMenu)}
        role="menu"
        ariaLabel={t("composer.addMenuLabel")}
        trigger={
          <button
            className={clsx("opengrove-action opengrove-composer-plus", styles.actionButton, styles.plusButton)}
            type="button"
            aria-haspopup="menu"
            aria-expanded={props.open}
            aria-label={t("composer.addMenuLabel")}
            title={t("composer.addMenuLabel")}
          >
            <ProductIcon name="add" size={20} />
          </button>
        }
      >
        <button
          className={clsx("opengrove-model-option", styles.option, styles.addOption)}
          type="button"
          role="menuitem"
          onClick={props.onOpenAttachmentPicker}
        >
          <span className={styles.addOptionIcon}>
            <FileText size={17} strokeWidth={2.1} />
          </span>
          <span className={styles.optionName}>{t("composer.addAttachment")}</span>
        </button>
        {props.canShowPlanMode || props.canShowGoalMode ? (
          <span className={styles.addMenuDivider} aria-hidden="true"></span>
        ) : null}
        {props.canShowPlanMode ? (
          <button
            className={clsx("opengrove-model-option", styles.option, styles.addOption)}
            type="button"
            role="menuitemcheckbox"
            aria-checked={props.planMode}
            onClick={props.onTogglePlanMode}
          >
            <span className={styles.addOptionIcon}>
              <ListChecks size={17} strokeWidth={2.1} />
            </span>
            <span className={styles.optionName}>{t("composer.planMode")}</span>
            <span className={styles.switchTrack} data-on={props.planMode ? "true" : "false"} aria-hidden="true">
              <span className={styles.switchThumb}></span>
            </span>
          </button>
        ) : null}
        {props.canShowGoalMode ? (
          <button
            className={clsx("opengrove-model-option", styles.option, styles.addOption)}
            type="button"
            role="menuitemcheckbox"
            aria-checked={props.goalMode}
            onClick={props.onToggleGoalMode}
          >
            <span className={styles.addOptionIcon}>
              <Target size={17} strokeWidth={2.1} />
            </span>
            <span className={styles.optionName}>{t("composer.goalMode")}</span>
            <span className={styles.switchTrack} data-on={props.goalMode ? "true" : "false"} aria-hidden="true">
              <span className={styles.switchThumb}></span>
            </span>
          </button>
        ) : null}
      </MotionPopover>
    </div>
  );
}

function ComposerAttachmentBar(props: {
  contextText: string;
  attachments: AttachmentPayload[];
  contextArtifacts: ContextArtifactPayload[];
  onClearContext(): void;
  onRemoveContextArtifact(artifactId: string): void;
  onRemoveAttachment(attachmentId: string): void;
}) {
  const { t } = useI18n();
  return (
    <div className={clsx("attachment-bar", styles.attachmentBar)}>
      {props.contextText ? (
        <div className={clsx("opengrove-attachment", styles.attachment)} data-kind="text">
          <span className={clsx("opengrove-attachment-icon", styles.attachmentIcon)} aria-hidden="true">
            <ClipboardPlus size={13} />
          </span>
          <span className={clsx("opengrove-attachment-name", styles.attachmentName)}>
            {t("composer.selectedText")} · {summarize(props.contextText, 90)}
          </span>
          <button
            className={clsx(
              "opengrove-action opengrove-icon opengrove-attachment-remove",
              styles.actionButton,
              styles.iconButton,
              styles.attachmentRemove,
            )}
            type="button"
            onClick={props.onClearContext}
            aria-label={t("composer.removeContext")}
          >
            ×
          </button>
        </div>
      ) : null}
      {props.contextArtifacts.map((artifact) => (
        <div className={clsx("opengrove-attachment", styles.attachment)} key={artifact.id} data-kind="artifact">
          <span className={clsx("opengrove-attachment-icon", styles.attachmentIcon)} aria-hidden="true">
            {artifact.imageUri ? <ImageIcon size={13} /> : <FileText size={13} />}
          </span>
          <span className={clsx("opengrove-attachment-name", styles.attachmentName)}>
            {artifact.title}
            <span className={clsx("opengrove-attachment-meta", styles.attachmentMeta)}>
              {" "}
              · {t("composer.artifact")}
            </span>
          </span>
          <button
            className={clsx(
              "opengrove-action opengrove-icon opengrove-attachment-remove",
              styles.actionButton,
              styles.iconButton,
              styles.attachmentRemove,
            )}
            type="button"
            onClick={() => props.onRemoveContextArtifact(artifact.id)}
            aria-label={t("composer.removeArtifact", { title: artifact.title })}
          >
            ×
          </button>
        </div>
      ))}
      {props.attachments.map((attachment) => {
        const Icon = attachmentIcon(attachment);
        if (attachment.kind === "image") {
          const previewUrl = attachmentImagePreviewUrl(attachment);
          return (
            <div
              className={clsx("opengrove-attachment", styles.attachment)}
              key={attachment.id}
              data-kind="image"
              title={attachment.name}
            >
              {previewUrl ? (
                <img className={clsx("opengrove-attachment-thumb", styles.attachmentThumb)} src={previewUrl} alt="" />
              ) : (
                <span
                  className={clsx("opengrove-attachment-image-fallback", styles.attachmentImageFallback)}
                  aria-hidden="true"
                >
                  <Icon size={18} />
                </span>
              )}
              <button
                className={clsx(
                  "opengrove-action opengrove-icon opengrove-attachment-remove",
                  styles.actionButton,
                  styles.iconButton,
                  styles.attachmentRemove,
                )}
                type="button"
                onClick={() => props.onRemoveAttachment(attachment.id)}
                aria-label={t("composer.removeAttachment", { name: attachment.name })}
              >
                ×
              </button>
            </div>
          );
        }
        return (
          <div
            className={clsx("opengrove-attachment", styles.attachment)}
            key={attachment.id}
            data-kind={attachment.kind}
          >
            <span className={clsx("opengrove-attachment-icon", styles.attachmentIcon)} aria-hidden="true">
              <Icon size={13} />
            </span>
            <span className={clsx("opengrove-attachment-name", styles.attachmentName)}>
              {attachment.name}
              <span className={clsx("opengrove-attachment-meta", styles.attachmentMeta)}>
                {formatAttachmentMeta(attachment)}
              </span>
            </span>
            <button
              className={clsx(
                "opengrove-action opengrove-icon opengrove-attachment-remove",
                styles.actionButton,
                styles.iconButton,
                styles.attachmentRemove,
              )}
              type="button"
              onClick={() => props.onRemoveAttachment(attachment.id)}
              aria-label={t("composer.removeAttachment", { name: attachment.name })}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ComposerAccessPicker(props: {
  accessMode: RuntimeAccessMode;
  open: boolean;
  placement: "up" | "down";
  onToggle(): void;
  onSetAccessMode(mode: RuntimeAccessMode): void;
}) {
  const { t } = useI18n();
  const activePreset = ACCESS_PRESETS.find((item) => item.id === props.accessMode) ?? ACCESS_PRESETS[0]!;
  return (
    <div className={clsx("opengrove-model-picker opengrove-access-picker", styles.modelPicker)}>
      <MotionPopover
        open={props.open}
        onOpenChange={(open) => {
          if (open !== props.open) props.onToggle();
        }}
        side={props.placement === "up" ? "top" : "bottom"}
        align="start"
        size="wide"
        className={clsx("opengrove-model-menu opengrove-access-menu", styles.menu, styles.accessMenu)}
        role="listbox"
        ariaLabel={t("composer.accessLabel")}
        trigger={
          <button
            className={clsx("opengrove-model-button opengrove-access-button", styles.modelButton)}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={props.open}
            aria-label={t("composer.accessLabel")}
            data-danger={activePreset.danger ? "true" : "false"}
          >
            <ProductIcon name="shield" size={15} />
            <span className={clsx("opengrove-model-label", styles.modelLabel)}>{t(activePreset.labelKey)}</span>
            <span className="opengrove-chevron" aria-hidden="true"></span>
          </button>
        }
      >
        <div className={clsx("opengrove-model-menu-title", styles.menuTitle)}>
          <span>{t("composer.accessQuestion")}</span>
        </div>
        {ACCESS_PRESETS.map((item) => {
          const OptionIcon = item.icon;
          return (
            <button
              key={item.id}
              className={clsx(
                "opengrove-model-option opengrove-model-option-with-description",
                styles.option,
                styles.optionWithDescription,
                styles.accessOption,
              )}
              type="button"
              aria-selected={item.id === activePreset.id}
              data-danger={item.danger ? "true" : "false"}
              onClick={() => props.onSetAccessMode(item.id)}
            >
              <span className={styles.accessOptionIcon} aria-hidden="true">
                <OptionIcon size={17} strokeWidth={2.1} />
              </span>
              <span className={clsx("opengrove-model-option-name", styles.optionName)}>
                {t(item.labelKey)}
                <span className={clsx("opengrove-model-option-description", styles.optionDescription)}>
                  {t(item.descriptionKey)}
                </span>
              </span>
              <span className={clsx("opengrove-model-option-check", styles.optionCheck)} aria-hidden="true">
                {item.id === activePreset.id ? <ProductIcon name="check" size={14} /> : null}
              </span>
            </button>
          );
        })}
      </MotionPopover>
    </div>
  );
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

// Context-window usage ring shown in the composer footer (the "O" both Claude Code and
// Codex desktop place there). The ring + used/total/% is identical across kernels; the
// hover popover shows Claude's per-category breakdown when available, otherwise a simple
// used / remaining / total summary (Codex).
function ContextWindowRing(props: { usage: ContextUsage }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const total = props.usage.total;
  const used = Math.max(0, Math.min(props.usage.used, total));
  const ratio = total > 0 ? used / total : 0;
  const percent = Math.round(ratio * 100);
  const remaining = Math.max(0, total - used);
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * ratio;
  const tone = ratio >= 0.9 ? "danger" : ratio >= 0.7 ? "warn" : "normal";
  const label = `${formatTokenCount(used)} / ${formatTokenCount(total)} (${percent}%)`;

  return (
    <div
      className={clsx("opengrove-context-ring", styles.contextRing)}
      data-open={open ? "true" : "false"}
      data-tone={tone}
    >
      <MotionPopover
        open={open}
        onOpenChange={setOpen}
        side="top"
        align="end"
        className={clsx("opengrove-context-ring-popover", styles.contextRingPopover)}
        role="dialog"
        ariaLabel={t("composer.contextWindow")}
        trigger={
          <button
            type="button"
            className={clsx("opengrove-context-ring-button", styles.contextRingButton)}
            aria-label={t("composer.contextWindow")}
            title={label}
            aria-expanded={open}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="9" cy="9" r={radius} fill="none" strokeWidth="2.4" className={styles.contextRingTrack} />
              <circle
                cx="9"
                cy="9"
                r={radius}
                fill="none"
                strokeWidth="2.4"
                strokeLinecap="round"
                transform="rotate(-90 9 9)"
                strokeDasharray={`${dash} ${circumference}`}
                className={styles.contextRingProgress}
              />
            </svg>
          </button>
        }
      >
        <div className={styles.contextRingHeader}>
          <span>{t("composer.contextWindow")}</span>
          <span>{label}</span>
        </div>
        {props.usage.breakdown?.length ? (
          <ul className={styles.contextRingList}>
            {props.usage.breakdown.map((entry) => (
              <li key={entry.category}>
                <span>{entry.category}</span>
                <span>{formatTokenCount(entry.tokens)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className={styles.contextRingList}>
            <li>
              <span>{t("composer.contextUsed")}</span>
              <span>{formatTokenCount(used)}</span>
            </li>
            <li>
              <span>{t("composer.contextRemaining")}</span>
              <span>{formatTokenCount(remaining)}</span>
            </li>
            <li>
              <span>{t("composer.contextTotal")}</span>
              <span>{formatTokenCount(total)}</span>
            </li>
          </ul>
        )}
      </MotionPopover>
    </div>
  );
}

function ComposerModelPicker(props: {
  model: ModelId;
  activeKernel?: string;
  runtimeControls?: RuntimeControls;
  effort: ReasoningEffort;
  responseSpeed: ResponseSpeed;
  budgetLimitUsd: number | null;
  canShowReasoningControls: boolean;
  canShowSpeedControls: boolean;
  canShowBudgetControls: boolean;
  open: boolean;
  placement: "up" | "down";
  onToggle(): void;
  onSetModel(model: ModelId): void;
  onSetEffort(effort: ReasoningEffort): void;
  onSetResponseSpeed(speed: ResponseSpeed): void;
  onSetBudgetLimitUsd(value: number | null): void;
}) {
  const { t } = useI18n();
  const controls = props.runtimeControls?.kernel === props.activeKernel ? props.runtimeControls : undefined;
  const modelOptions = modelOptionsForKernel(props.activeKernel, props.runtimeControls);
  const selectedModel = modelOptions.find((item) => modelOptionMatchesId(item, props.model)) ??
    modelOptions[0] ?? { id: props.model, label: props.model };
  // The reasoning-effort picker should appear whenever the kernel actually advertises
  // effort options (the backend then passes the choice through as model_reasoning_effort),
  // independent of whether readable reasoning summaries are surfaced. canShowReasoningControls
  // only governs summary display, so gating effort on it alone hid a control that works.
  const kernelAdvertisesEfforts = (controls?.reasoningEfforts?.length ?? 0) > 0;
  const effortOptions =
    props.canShowReasoningControls || kernelAdvertisesEfforts ? effortOptionsForRuntime(t, controls) : [];
  const speedOptions = props.canShowSpeedControls ? speedOptionsForRuntime(t, controls) : [];
  const effortEnabled = (props.canShowReasoningControls || kernelAdvertisesEfforts) && effortOptions.length > 0;
  const speedEnabled = props.canShowSpeedControls && speedOptions.length > 0;
  const budgetEnabled = props.canShowBudgetControls;
  const effortLabel = effortEnabled
    ? effortOptions.find((item) => item.id === props.effort)?.label || t("composer.effortHigh")
    : "";
  const budgetLabel = budgetEnabled && props.budgetLimitUsd ? `$${formatBudgetAmount(props.budgetLimitUsd)}` : "";
  const menuLabel = [
    speedEnabled ? t("composer.speed") : undefined,
    t("composer.model"),
    effortEnabled ? t("composer.intelligence") : undefined,
    budgetEnabled ? t("composer.budget") : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" / ");
  const compactModelLabel = selectedModel.id.startsWith("gpt-")
    ? selectedModel.id
        .replace(/^gpt-/, "")
        .replace(/-codex-spark$/, " spark")
        .replace(/-codex$/, " codex")
        .replace(/-mini$/, " mini")
    : modelLabel(selectedModel);

  return (
    <div className={clsx("opengrove-model-picker", styles.modelPicker)}>
      <MotionPopover
        open={props.open}
        onOpenChange={(open) => {
          if (open !== props.open) props.onToggle();
        }}
        side={props.placement === "up" ? "top" : "bottom"}
        align="end"
        size="picker"
        className={clsx("opengrove-model-menu", styles.menu)}
        role="listbox"
        ariaLabel={menuLabel}
        trigger={
          <button
            className={clsx(
              "opengrove-model-button opengrove-runtime-button",
              styles.modelButton,
              styles.runtimeButton,
            )}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={props.open}
            aria-label={menuLabel}
            data-speed={speedEnabled ? props.responseSpeed : undefined}
          >
            {speedEnabled && props.responseSpeed === "fast" ? <Zap size={15} strokeWidth={2.1} /> : null}
            <span className={clsx("opengrove-model-label", styles.modelLabel)}>{compactModelLabel}</span>
            {effortLabel ? (
              <span className={clsx("opengrove-model-effort", styles.modelEffort)}>{effortLabel}</span>
            ) : null}
            {budgetLabel ? <CircleDollarSign size={14} strokeWidth={2.1} /> : null}
            {budgetLabel ? (
              <span className={clsx("opengrove-model-effort", styles.modelEffort)}>{budgetLabel}</span>
            ) : null}
            <span className="opengrove-chevron" aria-hidden="true"></span>
          </button>
        }
      >
        {effortEnabled ? (
          <>
            <div className={clsx("opengrove-model-menu-title", styles.menuTitle)}>{t("composer.intelligence")}</div>
            {effortOptions.map((item) => (
              <button
                key={item.id}
                className={clsx("opengrove-model-option", styles.option)}
                type="button"
                aria-selected={item.id === props.effort}
                onClick={() => props.onSetEffort(item.id)}
              >
                <span className={clsx("opengrove-model-option-name", styles.optionName)}>{item.label}</span>
                <span className={clsx("opengrove-model-option-check", styles.optionCheck)} aria-hidden="true">
                  {item.id === props.effort ? <ProductIcon name="check" size={14} /> : null}
                </span>
              </button>
            ))}
          </>
        ) : null}
        <div className={clsx("opengrove-model-menu-title", styles.menuTitle)}>{t("composer.model")}</div>
        {modelOptions.map((item) => (
          <button
            key={item.id}
            className={clsx("opengrove-model-option", styles.option)}
            type="button"
            aria-selected={item.id === selectedModel.id}
            onClick={() => props.onSetModel(item.id as ModelId)}
          >
            <span className={clsx("opengrove-model-option-name", styles.optionName)}>{modelLabel(item)}</span>
            <span className={clsx("opengrove-model-option-check", styles.optionCheck)} aria-hidden="true">
              {item.id === selectedModel.id ? <ProductIcon name="check" size={14} /> : null}
            </span>
          </button>
        ))}
        {speedEnabled ? (
          <>
            <div className={clsx("opengrove-model-menu-title", styles.menuTitle)}>{t("composer.speed")}</div>
            {speedOptions.map((item) => (
              <button
                key={item.id}
                className={clsx(
                  "opengrove-model-option opengrove-model-option-with-description",
                  styles.option,
                  styles.optionWithDescription,
                )}
                type="button"
                aria-selected={item.id === props.responseSpeed}
                onClick={() => props.onSetResponseSpeed(item.id)}
              >
                <span className={clsx("opengrove-model-option-name", styles.optionName)}>
                  {item.label}
                  <span className={clsx("opengrove-model-option-description", styles.optionDescription)}>
                    {item.description}
                  </span>
                </span>
                <span className={clsx("opengrove-model-option-check", styles.optionCheck)} aria-hidden="true">
                  {item.id === props.responseSpeed ? <ProductIcon name="check" size={14} /> : null}
                </span>
              </button>
            ))}
          </>
        ) : null}
        {budgetEnabled ? (
          <>
            <div className={clsx("opengrove-model-menu-title", styles.menuTitle)}>{t("composer.budget")}</div>
            {BUDGET_OPTIONS.map((item) => {
              const selected =
                item.value === null ? props.budgetLimitUsd === null : props.budgetLimitUsd === item.value;
              return (
                <button
                  key={item.value ?? "off"}
                  className={clsx(
                    "opengrove-model-option opengrove-model-option-with-description",
                    styles.option,
                    styles.optionWithDescription,
                  )}
                  type="button"
                  aria-selected={selected}
                  onClick={() => props.onSetBudgetLimitUsd(item.value)}
                >
                  <span className={clsx("opengrove-model-option-name", styles.optionName)}>
                    {t(item.labelKey)}
                    <span className={clsx("opengrove-model-option-description", styles.optionDescription)}>
                      {t(item.descriptionKey)}
                    </span>
                  </span>
                  <span className={clsx("opengrove-model-option-check", styles.optionCheck)} aria-hidden="true">
                    {selected ? <ProductIcon name="check" size={14} /> : null}
                  </span>
                </button>
              );
            })}
          </>
        ) : null}
      </MotionPopover>
    </div>
  );
}

function formatBudgetAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
