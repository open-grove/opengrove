import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";
import type {
  KernelOption,
  ModelId,
  ModelProviderBinding,
  ProviderProfile,
  ReasoningEffort,
  RuntimeControls,
} from "../../bridge";
import { DEFAULT_MODEL_ID } from "../../bridge";
import { useI18n, type TranslationFn, type TranslationKey } from "../../i18n";
import {
  collapseModelOptions,
  isKernelDefaultModelOption,
  kernelExecutableProbeDescription,
  kernelUnavailableDescription,
  modelLabel,
  modelOptionMatchesId,
  modelOptionsForKernel,
  resolveDefaultModelForKernel,
  runtimeControlsForKernel,
} from "../../runtime/kernel-models";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { KernelIcon } from "../ui/entity-icons";
import { IdentityImageTrigger } from "../ui/identity-image-trigger";
import { Tooltip } from "../ui/tooltip";
import {
  isProviderUsable,
  modelIdsEquivalent,
  modelOptionServesSelection,
  providerDisplayName,
  providerRouteIdForKernel,
  providerServesModel,
  providerSupportsKernel,
} from "../sidebar/settings-model";
import { normalizeSkillIds } from "./contacts-model";
import { EmployeeAvatarPicker } from "./employee-avatar-picker";
import { RoomMemberAvatar } from "./member-avatar";
import { RoomInlineSelect } from "./room-inline-select";
import "./room-dialogs.css";
import {
  KERNEL_COLORS,
  MEMBER_ACCESS_PRESETS,
  createId,
  isEmployeeKernelSelectable,
  normalizeRoomMemberModelForKernel,
  roomMemberFromKernel,
  roomMemberSourceLabel,
  selectableKernelOptions,
  type RoomMember,
  type RoomMemberAccessMode,
  type RoomMemberAvatarMode,
} from "./rooms-model";
import { isSupportedRoomMemberAvatarDataUrl } from "../../../../src/rooms/avatar-data-url";

type EmployeeDraft = {
  id: string;
  name: string;
  avatarMode: RoomMemberAvatarMode;
  avatarSeed: string;
  avatarDataUrl: string;
  legacyInvalidAvatar: boolean;
  kernel: string;
  model: string;
  providerId: string;
  reasoningEffort: ReasoningEffort | "";
  accessMode: RoomMemberAccessMode;
  role: string;
  visibility: "private" | "public";
  publicDescription: string;
  publicSkillsText: string;
  inputSpec: string;
  outputSpec: string;
  contextTokenBudget: string;
};

export type EmployeeKernelRuntimeDraft = Pick<EmployeeDraft, "model" | "providerId" | "reasoningEffort">;

export function switchEmployeeKernelRuntimeDraft(
  draftsByKernel: Record<string, EmployeeKernelRuntimeDraft>,
  currentKernelId: string,
  currentSelection: EmployeeKernelRuntimeDraft,
  nextKernelId: string,
  fallbackSelection: EmployeeKernelRuntimeDraft,
): { draftsByKernel: Record<string, EmployeeKernelRuntimeDraft>; selection: EmployeeKernelRuntimeDraft } {
  const nextDrafts = {
    ...draftsByKernel,
    [currentKernelId]: currentSelection,
  };
  return {
    draftsByKernel: nextDrafts,
    selection: nextDrafts[nextKernelId] ?? fallbackSelection,
  };
}

export type EmployeeEditorTab = "profile" | "runtime" | "collaboration";

type EmployeeDialogProps = {
  open: boolean;
  activeKernel?: string;
  activeModel: ModelId;
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  kernelOptions: KernelOption[];
  providers: ProviderProfile[] | undefined;
  modelProviderBindings: ModelProviderBinding[] | undefined;
  providerRoutingEnabled?: boolean;
  initialMember?: RoomMember;
  onOpenChange(open: boolean): void;
  onCreate(member: RoomMember): unknown | Promise<unknown>;
  onSave?(member: RoomMember): unknown | Promise<unknown>;
  onDraftPatch?(patch: Partial<RoomMember>, options: { immediate?: boolean }): void;
  embedded?: boolean;
  activeTab?: EmployeeEditorTab;
  onActiveTabChange?(tab: EmployeeEditorTab): void;
  showTabs?: boolean;
  showPreview?: boolean;
  showCancel?: boolean;
  showRuntimeNote?: boolean;
  showSubmitActions?: boolean;
};

export function EmployeeDialog(props: EmployeeDialogProps) {
  const { t } = useI18n();
  const instanceId = useId().replace(/:/g, "");
  const editing = Boolean(props.initialMember);
  const availableKernels = useMemo(
    () => selectableKernelOptions(props.kernelOptions, props.activeKernel, props.initialMember?.kernel),
    [props.activeKernel, props.initialMember?.kernel, props.kernelOptions],
  );
  const defaultKernel = useMemo(
    () =>
      availableKernels.find((kernel) => kernel.id === props.activeKernel) ??
      availableKernels.find(isKernelReady) ??
      availableKernels[0],
    [availableKernels, props.activeKernel],
  );
  const kernelRuntimeDraftsRef = useRef<Record<string, EmployeeKernelRuntimeDraft>>({});
  const [draft, setDraft] = useState<EmployeeDraft>(() => {
    const initialDraft = createDefaultDraft(
      defaultKernel,
      props.activeKernel,
      props.activeModel,
      props.runtimeControls,
      props.runtimeControlsByKernel,
      props.initialMember,
      props.providers,
    );
    kernelRuntimeDraftsRef.current = {
      [initialDraft.kernel]: employeeKernelRuntimeDraft(initialDraft),
    };
    return initialDraft;
  });
  const draftRef = useRef(draft);
  const [submitPending, setSubmitPending] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [internalActiveTab, setInternalActiveTab] = useState<EmployeeEditorTab>("profile");
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const previousOpenRef = useRef(false);
  const previousInitialMemberIdRef = useRef<string | undefined>(props.initialMember?.id);
  const previousInitialMemberSignatureRef = useRef(employeeDraftSourceSignature(props.initialMember));
  const pendingAutosaveEchoesRef = useRef<RoomMember[]>([]);
  const draftDirtyRef = useRef(false);
  const draftRevisionRef = useRef(0);
  const onSaveRef = useRef(props.onSave);
  onSaveRef.current = props.onSave;

  const updateDraft = useCallback(
    (action: SetStateAction<EmployeeDraft>, options?: { fields?: Array<keyof RoomMember>; immediate?: boolean }) => {
      const current = draftRef.current;
      const next = typeof action === "function" ? action(current) : action;
      if (Object.is(current, next)) return;
      const hadUnsubmittedDraft = draftDirtyRef.current;
      draftRef.current = next;
      draftRevisionRef.current += 1;
      setSubmitError("");
      if (options?.fields?.length) {
        const member = createMemberFromDraft(next, {
          initialMember: props.initialMember,
        });
        const patch = {} as Partial<RoomMember>;
        for (const field of options.fields) {
          (patch as Record<keyof RoomMember, RoomMember[keyof RoomMember] | undefined>)[field] = member[field];
        }
        if (props.onDraftPatch) {
          const expectedBase = pendingAutosaveEchoesRef.current.at(-1) ?? props.initialMember ?? member;
          pendingAutosaveEchoesRef.current.push({ ...expectedBase, ...patch });
          props.onDraftPatch(patch, { immediate: options.immediate });
        }
      }
      const nextDirty = props.onDraftPatch && options?.fields?.length ? hadUnsubmittedDraft : true;
      draftDirtyRef.current = nextDirty;
      setDraftDirty(nextDirty);
      setDraft(next);
    },
    [props.initialMember, props.onDraftPatch],
  );

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    const previousInitialMemberId = previousInitialMemberIdRef.current;
    const currentInitialMemberId = props.initialMember?.id;
    const previousInitialMemberSignature = previousInitialMemberSignatureRef.current;
    const currentInitialMemberSignature = employeeDraftSourceSignature(props.initialMember);
    previousOpenRef.current = props.open;
    previousInitialMemberIdRef.current = currentInitialMemberId;
    previousInitialMemberSignatureRef.current = currentInitialMemberSignature;
    if (!props.open) {
      setSubmitPending(false);
      setDraftDirty(false);
      setAvatarPickerOpen(false);
      draftDirtyRef.current = false;
      pendingAutosaveEchoesRef.current = [];
      return;
    }
    const autosaveEcho =
      wasOpen &&
      previousInitialMemberId === currentInitialMemberId &&
      previousInitialMemberSignature !== currentInitialMemberSignature &&
      consumeEmployeeAutosaveEcho(pendingAutosaveEchoesRef.current, props.initialMember);
    if (
      !wasOpen ||
      previousInitialMemberId !== currentInitialMemberId ||
      (previousInitialMemberSignature !== currentInitialMemberSignature && !draftDirtyRef.current && !autosaveEcho)
    ) {
      const nextDraft = createDefaultDraft(
        defaultKernel,
        props.activeKernel,
        props.activeModel,
        props.runtimeControls,
        props.runtimeControlsByKernel,
        props.initialMember,
        props.providers,
      );
      kernelRuntimeDraftsRef.current = {
        [nextDraft.kernel]: employeeKernelRuntimeDraft(nextDraft),
      };
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      setSubmitPending(false);
      setSubmitError("");
      setDraftDirty(false);
      setInternalActiveTab("profile");
      setAvatarPickerOpen(false);
      draftDirtyRef.current = false;
      draftRevisionRef.current = 0;
      pendingAutosaveEchoesRef.current = [];
    }
  }, [
    defaultKernel,
    props.activeKernel,
    props.activeModel,
    props.open,
    props.runtimeControls,
    props.runtimeControlsByKernel,
    props.initialMember,
    props.providers,
    t,
  ]);

  const selectedKernel = availableKernels.find((kernel) => kernel.id === draft.kernel) ?? defaultKernel;
  const selectedRuntimeControls = runtimeControlsForKernel(
    draft.kernel,
    props.runtimeControls,
    props.runtimeControlsByKernel,
  );
  const availableModelOptions = useMemo(
    () => employeeModelOptions(draft.kernel, selectedRuntimeControls, props.providers ?? []),
    [draft.kernel, props.providers, selectedRuntimeControls],
  );
  const modelOptions = useMemo(
    () => includeUnavailableEmployeeModelOption(availableModelOptions, draft.model, t("common.unavailable")),
    [availableModelOptions, draft.model, t],
  );
  const reasoningControl = useMemo(
    () =>
      employeeReasoningControl(
        selectedRuntimeControls,
        draft.reasoningEffort,
        props.initialMember?.manifestDefaults?.reasoningEffort ?? "",
        t,
      ),
    [draft.reasoningEffort, props.initialMember?.manifestDefaults?.reasoningEffort, selectedRuntimeControls, t],
  );
  const reasoningOptions = reasoningControl.options;
  const selectedModel = modelOptions.find((option) => modelOptionMatchesId(option, draft.model)) ?? modelOptions[0];
  const providerSelection = useMemo(
    () =>
      employeeProviderSelection(
        draft.kernel,
        draft.model,
        props.providers ?? [],
        props.modelProviderBindings ?? [],
        selectedKernel,
        draft.providerId,
        t,
      ),
    [draft.kernel, draft.model, draft.providerId, props.modelProviderBindings, props.providers, selectedKernel, t],
  );
  const providerOptions = providerSelection.options;
  const providerRoutingEnabled = props.providerRoutingEnabled !== false;
  const selectedKernelReady = Boolean(selectedKernel && isKernelReady(selectedKernel));
  const contextBudgetInvalid = Boolean(
    draft.contextTokenBudget.trim() && !positiveTokenBudget(draft.contextTokenBudget),
  );
  const canSubmit =
    canSubmitDraft(draft, selectedKernelReady) &&
    (!providerRoutingEnabled || Boolean(draft.providerId || providerSelection.defaultProviderId)) &&
    (!editing || draftDirty) &&
    !submitPending;
  const activeTab = props.activeTab ?? internalActiveTab;
  const showPreview = props.showPreview ?? editing;

  function selectTab(tab: EmployeeEditorTab) {
    if (props.activeTab === undefined) setInternalActiveTab(tab);
    props.onActiveTabChange?.(tab);
  }

  function updateKernel(kernelId: string) {
    if (draftRef.current.kernel === kernelId) return;
    const kernel = availableKernels.find((item) => item.id === kernelId);
    updateDraft(
      (current) => {
        if (current.kernel === kernelId) return current;
        const currentKernel = availableKernels.find((item) => item.id === current.kernel);
        const switched = switchEmployeeKernelRuntimeDraft(
          kernelRuntimeDraftsRef.current,
          current.kernel,
          employeeKernelRuntimeDraft(current),
          kernelId,
          {
            model: resolveDefaultModel(
              kernelId,
              props.activeKernel,
              props.activeModel,
              props.runtimeControls,
              props.runtimeControlsByKernel,
              props.providers,
            ),
            providerId: "",
            reasoningEffort: "",
          },
        );
        kernelRuntimeDraftsRef.current = switched.draftsByKernel;
        return {
          ...current,
          name: shouldReplaceDefaultEmployeeName(current.name, currentKernel?.label)
            ? defaultEmployeeName(kernel)
            : current.name,
          kernel: kernelId,
          ...switched.selection,
          role: current.role,
        };
      },
      {
        fields: ["kernel", "model", "providerId", "reasoningEffort"],
        immediate: true,
      },
    );
  }

  async function saveEmployeeDraft(draftToSave: EmployeeDraft, revision: number, closeAfterSave: boolean) {
    const kernel = availableKernels.find((candidate) => candidate.id === draftToSave.kernel) ?? defaultKernel;
    setSubmitPending(true);
    const base = kernel ? roomMemberFromKernel(kernel, props.activeKernel, props.activeModel) : undefined;
    const member = createMemberFromDraft(draftToSave, {
      base,
      initialMember: props.initialMember,
    });
    try {
      if (editing) {
        await onSaveRef.current?.(member);
      } else {
        await props.onCreate(member);
      }
      if (revision === draftRevisionRef.current) {
        draftDirtyRef.current = false;
        setDraftDirty(false);
      }
      setSubmitError("");
      if (closeAfterSave) props.onOpenChange(false);
    } catch (error) {
      setSubmitError(
        t(editing ? "contacts.saveFailed" : "contacts.addEmployeeFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSubmitPending(false);
    }
  }

  async function submitEmployee() {
    if (!canSubmit) return;
    await saveEmployeeDraft(draft, draftRevisionRef.current, !props.embedded);
  }

  function updateContextTokenBudget(value: string) {
    const valid = !value.trim() || Boolean(positiveTokenBudget(value));
    updateDraft(
      (current) => ({ ...current, contextTokenBudget: value }),
      valid ? { fields: ["contextTokenBudget"] } : undefined,
    );
  }

  const editorContent = (
    <>
      {props.embedded ? null : (
        <DialogTitle>{editing ? t("employee.profileSettingsTitle") : t("employee.addEmployee")}</DialogTitle>
      )}
      {showPreview ? (
        <div className="employee-dialog-preview">
          <RoomMemberAvatar
            member={draftPreviewMember(draft, props.initialMember)}
            className="rooms-avatar"
            showStatus={false}
          />
          <div>
            <strong>{draft.name.trim() || t("employee.newEmployeeName")}</strong>
            <small>{previewSubtitle(draft, selectedKernel?.label, selectedModel?.label, t)}</small>
          </div>
        </div>
      ) : null}
      {props.showTabs === false ? null : (
        <div className="employee-dialog-tabs" role="tablist" aria-label={t("employee.settingsSectionsLabel")}>
          {(
            [
              ["profile", t("employee.profileTab")],
              ["runtime", t("employee.runtimeSettingsTitle")],
              ["collaboration", t("employee.responsibilityTitle")],
            ] as Array<[EmployeeEditorTab, string]>
          ).map(([tab, label]) => (
            <button
              key={tab}
              id={`${instanceId}-${tab}-tab`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`${instanceId}-${tab}-panel`}
              data-active={activeTab === tab ? "true" : "false"}
              onClick={() => selectTab(tab)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {activeTab === "profile" ? (
        <section
          id={`${instanceId}-profile-panel`}
          className="employee-dialog-card employee-dialog-tab-panel employee-dialog-identity-card"
          role="tabpanel"
          aria-labelledby={props.showTabs === false ? undefined : `${instanceId}-profile-tab`}
          aria-label={props.showTabs === false ? t("employee.profileTab") : undefined}
        >
          <div className="employee-dialog-profile-hero">
            <IdentityImageTrigger
              label={t("employee.avatarTitle")}
              title={draft.name.trim() || t("employee.newEmployeeName")}
              onClick={() => setAvatarPickerOpen(true)}
            >
              <RoomMemberAvatar
                member={draftPreviewMember(draft, props.initialMember)}
                className="employee-dialog-profile-hero-avatar"
                showStatus={false}
              />
            </IdentityImageTrigger>
          </div>
          <label className="employee-dialog-field employee-dialog-profile-name-row">
            <span>{t("employee.nameLabel")}</span>
            <input
              value={draft.name}
              onChange={(event) =>
                updateDraft((current) => ({ ...current, name: event.target.value }), { fields: ["name"] })
              }
              placeholder={t("employee.namePlaceholder")}
            />
          </label>
        </section>
      ) : null}
      {activeTab === "runtime" ? (
        <section
          id={`${instanceId}-runtime-panel`}
          className="employee-dialog-card employee-dialog-tab-panel employee-dialog-runtime-card"
          role="tabpanel"
          aria-labelledby={props.showTabs === false ? undefined : `${instanceId}-runtime-tab`}
          aria-label={props.showTabs === false ? t("employee.runtimeSettingsTitle") : undefined}
        >
          <section className="employee-dialog-runtime" aria-label={t("employee.runtimeGroupLabel")}>
            <h3 className="employee-dialog-runtime-title">Kernel</h3>
            <div className="employee-dialog-kernel-list">
              {availableKernels.map((kernel) => (
                <Tooltip
                  key={kernel.id}
                  content={
                    (kernel.available
                      ? kernelExecutableProbeDescription(kernel, t)
                      : kernelUnavailableDescription(kernel, t)) ||
                    kernel.providerLabel ||
                    kernel.version ||
                    kernel.id
                  }
                >
                  <button
                    className="employee-dialog-kernel-option"
                    data-active={kernel.id === draft.kernel ? "true" : "false"}
                    data-ready={isKernelReady(kernel) ? "true" : "false"}
                    type="button"
                    disabled={!isKernelReady(kernel)}
                    onClick={() => updateKernel(kernel.id)}
                  >
                    <KernelIcon kernelId={kernel.id} className="employee-dialog-kernel-icon" size={20} />
                    <span>
                      <strong>{kernel.label || kernel.id}</strong>
                    </span>
                  </button>
                </Tooltip>
              ))}
              {!availableKernels.length ? (
                <div className="rooms-empty-row">{t("employee.noSelectableKernels")}</div>
              ) : null}
            </div>
          </section>
          <section
            className="employee-dialog-runtime-settings employee-dialog-runtime-settings-card"
            aria-label={t("employee.runtimeSettingsTitle")}
          >
            <header className="employee-dialog-runtime-settings-heading">
              <h3 className="employee-dialog-runtime-title">{t("employee.runtimeSettingsTitle")}</h3>
            </header>
            <div className="employee-dialog-runtime-fields">
              {!modelOptions.length ? (
                <div className="employee-dialog-field">
                  <span>{t("composer.model")}</span>
                  <span className="employee-dialog-model-note">{t("settings.noAvailableModelsHint")}</span>
                </div>
              ) : modelOptions.length === 1 &&
                isKernelDefaultModelOption(draft.kernel, modelOptions[0]!, selectedRuntimeControls) ? (
                <div className="employee-dialog-field">
                  <span>{t("composer.model")}</span>
                  <span className="employee-dialog-model-note">
                    {modelLabel(modelOptions[0]!)}
                    {t("settings.modelDeterminedByKernelLogin")}
                  </span>
                </div>
              ) : (
                <div className="employee-dialog-field">
                  <span>{t("composer.model")}</span>
                  <RoomInlineSelect
                    value={selectedModel?.id ?? draft.model}
                    menuSize="content"
                    options={modelOptions.map((option) => ({ id: option.id, label: modelLabel(option) }))}
                    onChange={(model) =>
                      updateDraft((current) => ({ ...current, model, providerId: "" }), {
                        fields: ["model", "providerId"],
                        immediate: true,
                      })
                    }
                  />
                </div>
              )}
              {providerRoutingEnabled && providerOptions.length ? (
                <div className="employee-dialog-field">
                  <span>{t("employee.providerLabel")}</span>
                  <RoomInlineSelect
                    value={draft.providerId || providerSelection.defaultProviderId}
                    options={providerOptions}
                    onChange={(providerId) =>
                      updateDraft(
                        (current) => ({
                          ...current,
                          providerId: providerId === providerSelection.defaultProviderId ? "" : providerId,
                        }),
                        { fields: ["providerId"], immediate: true },
                      )
                    }
                  />
                </div>
              ) : null}
              {reasoningControl.status !== "unsupported" ? (
                <div className="employee-dialog-field">
                  <span>{t("contacts.reasoningLevel")}</span>
                  {reasoningControl.status === "loading" ? (
                    <span aria-busy="true">{t(REASONING_EFFORT_LABEL_KEYS[reasoningControl.value])}</span>
                  ) : (
                    <RoomInlineSelect
                      value={reasoningControl.value}
                      options={reasoningOptions}
                      onChange={(effort) => {
                        if (isReasoningEffort(effort)) {
                          updateDraft((current) => ({ ...current, reasoningEffort: effort }), {
                            fields: ["reasoningEffort"],
                            immediate: true,
                          });
                        }
                      }}
                    />
                  )}
                </div>
              ) : null}
              <div className="employee-dialog-field">
                <span>{t("contacts.accessTitle")}</span>
                <RoomInlineSelect
                  value={draft.accessMode}
                  menuSize="wide"
                  options={MEMBER_ACCESS_PRESETS.map((preset) => ({
                    id: preset.id,
                    label: preset.label,
                    description: preset.description,
                    tone: preset.danger ? ("danger" as const) : undefined,
                  }))}
                  onChange={(accessMode) =>
                    updateDraft(
                      (current) => ({
                        ...current,
                        accessMode: accessMode as RoomMemberAccessMode,
                      }),
                      { fields: ["accessMode"], immediate: true },
                    )
                  }
                />
              </div>
              {!selectedKernelReady && selectedKernel ? (
                <div className="employee-dialog-warning">
                  {kernelUnavailableDescription(selectedKernel, t) || t("employee.kernelNotInstalledWarning")}
                </div>
              ) : null}
              <label className="employee-dialog-field">
                <span>{t("contacts.contextBudgetLabel")}</span>
                <input
                  type="number"
                  min={1}
                  step={1000}
                  value={draft.contextTokenBudget}
                  placeholder={t("employee.contextBudgetPlaceholder")}
                  aria-invalid={contextBudgetInvalid}
                  onChange={(event) => updateContextTokenBudget(event.target.value)}
                />
              </label>
            </div>
            {props.showRuntimeNote === false ? null : (
              <p className="employee-dialog-runtime-note">{t("contacts.contextBudgetHint")}</p>
            )}
          </section>
        </section>
      ) : null}
      {activeTab === "collaboration" ? (
        <section
          id={`${instanceId}-collaboration-panel`}
          className="employee-dialog-card employee-dialog-tab-panel employee-dialog-responsibility-card"
          role="tabpanel"
          aria-labelledby={props.showTabs === false ? undefined : `${instanceId}-collaboration-tab`}
          aria-label={props.showTabs === false ? t("employee.responsibilityTitle") : undefined}
        >
          <section className="employee-dialog-collaboration-section">
            <h3>{t("employee.roleLabel")}</h3>
            <textarea
              className="employee-dialog-responsibility-textarea"
              aria-label={t("employee.roleLabel")}
              value={draft.role}
              onChange={(event) =>
                updateDraft((current) => ({ ...current, role: event.target.value }), { fields: ["role"] })
              }
              placeholder={t("employee.rolePlaceholder")}
              rows={4}
            />
          </section>
          <section className="employee-dialog-collaboration-section">
            <h3>{t("employee.publicContractTitle")}</h3>
            <p className="employee-dialog-section-note">{t("employee.publishNotice")}</p>
            <div className="employee-dialog-a2a-card" aria-label={t("employee.publicContractTitle")}>
              <div className="employee-dialog-a2a-visibility">
                <strong>{t("contacts.visibility")}</strong>
                <div
                  className="employee-dialog-contract-segmented"
                  role="radiogroup"
                  aria-label={t("employee.visibilityGroupLabel")}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.visibility !== "public"}
                    tabIndex={draft.visibility !== "public" ? 0 : -1}
                    data-active={draft.visibility !== "public" ? "true" : "false"}
                    onKeyDown={handleRadioGroupKeyDown}
                    onClick={() =>
                      updateDraft((current) => ({ ...current, visibility: "private" }), {
                        fields: ["visibility"],
                        immediate: true,
                      })
                    }
                  >
                    {t("employee.visibilityPrivate")}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.visibility === "public"}
                    tabIndex={draft.visibility === "public" ? 0 : -1}
                    data-active={draft.visibility === "public" ? "true" : "false"}
                    onKeyDown={handleRadioGroupKeyDown}
                    onClick={() =>
                      updateDraft((current) => ({ ...current, visibility: "public" }), {
                        fields: ["visibility"],
                        immediate: true,
                      })
                    }
                  >
                    {t("employee.visibilityPublic")}
                  </button>
                </div>
              </div>
              <label className="employee-dialog-field">
                <span>{t("employee.publicDescriptionLabel")}</span>
                <textarea
                  value={draft.publicDescription}
                  onChange={(event) =>
                    updateDraft((current) => ({ ...current, publicDescription: event.target.value }), {
                      fields: ["publicDescription"],
                    })
                  }
                  placeholder={t("employee.publicDescriptionPlaceholder")}
                  rows={2}
                />
              </label>
              <label className="employee-dialog-field">
                <span>{t("employee.publicSkillsLabel")}</span>
                <textarea
                  value={draft.publicSkillsText}
                  onChange={(event) =>
                    updateDraft((current) => ({ ...current, publicSkillsText: event.target.value }), {
                      fields: ["publicSkills"],
                    })
                  }
                  placeholder={t("employee.publicSkillsPlaceholder")}
                  rows={2}
                />
              </label>
              <div className="employee-dialog-contract-grid">
                <label className="employee-dialog-field">
                  <span>{t("employee.inputSpecLabel")}</span>
                  <textarea
                    value={draft.inputSpec}
                    onChange={(event) =>
                      updateDraft((current) => ({ ...current, inputSpec: event.target.value }), {
                        fields: ["inputSpec"],
                      })
                    }
                    placeholder={t("employee.inputSpecPlaceholder")}
                    rows={2}
                  />
                </label>
                <label className="employee-dialog-field">
                  <span>{t("employee.outputSpecLabel")}</span>
                  <textarea
                    value={draft.outputSpec}
                    onChange={(event) =>
                      updateDraft((current) => ({ ...current, outputSpec: event.target.value }), {
                        fields: ["outputSpec"],
                      })
                    }
                    placeholder={t("employee.outputSpecPlaceholder")}
                    rows={2}
                  />
                </label>
              </div>
            </div>
          </section>
        </section>
      ) : null}
      <EmployeeAvatarPicker
        open={avatarPickerOpen}
        member={draftPreviewMember(draft, props.initialMember)}
        onOpenChange={setAvatarPickerOpen}
        onConfirm={(patch) =>
          updateDraft(
            (current) => ({
              ...current,
              avatarMode: patch.avatarMode ?? "generated",
              avatarSeed: patch.avatarSeed ?? "",
              avatarDataUrl: patch.avatarDataUrl ?? "",
              legacyInvalidAvatar: false,
            }),
            {
              fields: ["avatarMode", "avatarSeed", "avatarDataUrl"],
              immediate: true,
            },
          )
        }
      />
      {contextBudgetInvalid ? (
        <p className="employee-dialog-submit-error" role="alert">
          {t("employee.contextBudgetInvalid")}
        </p>
      ) : null}
      {submitError ? (
        <p className="employee-dialog-submit-error" role="alert">
          {submitError}
        </p>
      ) : null}
      {props.showSubmitActions === false ? null : (
        <>
          <div className="modal-actions">
            {props.showCancel === false ? null : (
              <button className="ghost-button" type="button" onClick={() => props.onOpenChange(false)}>
                {t("common.cancel")}
              </button>
            )}
            <button
              className="primary-button"
              type="button"
              onClick={() => void submitEmployee()}
              disabled={!canSubmit}
            >
              {submitPending ? t("settings.providerSaving") : editing ? t("filePreview.save") : t("mountedApp.create")}
            </button>
          </div>
        </>
      )}
    </>
  );

  if (props.embedded) {
    return (
      <section
        className="employee-dialog employee-dialog-embedded"
        aria-label={editing ? t("employee.editEmployee") : t("employee.addEmployee")}
      >
        {editorContent}
      </section>
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="employee-dialog"
        aria-label={editing ? t("employee.editEmployee") : t("employee.addEmployee")}
      >
        {editorContent}
      </DialogContent>
    </Dialog>
  );
}

function isKernelReady(kernel: KernelOption | undefined): boolean {
  return isEmployeeKernelSelectable(kernel);
}

export function canSubmitDraft(draft: EmployeeDraft, selectedKernelReady: boolean): boolean {
  return Boolean(
    draft.name.trim() &&
      draft.kernel &&
      draft.model &&
      selectedKernelReady &&
      (draft.avatarMode !== "upload" ||
        draft.legacyInvalidAvatar ||
        isSupportedRoomMemberAvatarDataUrl(draft.avatarDataUrl)) &&
      (!draft.contextTokenBudget.trim() || positiveTokenBudget(draft.contextTokenBudget)),
  );
}

export function createDefaultDraft(
  kernel: KernelOption | undefined,
  activeKernel: string | undefined,
  activeModel: ModelId,
  runtimeControls: RuntimeControls | undefined,
  runtimeControlsByKernel: Record<string, RuntimeControls> | undefined,
  initialMember: RoomMember | undefined,
  providers?: ProviderProfile[],
): EmployeeDraft {
  const id = initialMember?.id || createId("employee");
  const kernelId = initialMember?.kernel || kernel?.id || activeKernel || "";
  const avatarMode = initialMember?.avatarMode ?? (initialMember?.avatarDataUrl ? "upload" : "generated");
  return {
    id,
    name: memberPresentationDraft(initialMember, "name", "displayName") || defaultEmployeeName(kernel),
    avatarMode,
    avatarSeed: initialMember?.avatarSeed ?? "",
    avatarDataUrl: initialMember?.avatarDataUrl ?? "",
    legacyInvalidAvatar: hasLegacyInvalidAvatar(initialMember),
    kernel: kernelId,
    model: initialMember
      ? normalizeRoomMemberModelForKernel(kernelId, initialMember.model)
      : resolveDefaultModel(kernelId, activeKernel, activeModel, runtimeControls, runtimeControlsByKernel, providers),
    providerId: initialMember?.providerId ?? "",
    reasoningEffort: employeeReasoningOverrideDraft(initialMember),
    accessMode: initialMember?.accessMode ?? "default",
    role: memberPresentationDraft(initialMember, "role", "displayRole"),
    visibility: initialMember?.visibility ?? "private",
    publicDescription: memberPresentationDraft(initialMember, "publicDescription", "displayPublicDescription"),
    publicSkillsText: publicSkillsText(
      initialMember?.userOverrides?.includes("publicSkills")
        ? initialMember.publicSkills
        : (initialMember?.displayPublicSkills ?? initialMember?.publicSkills),
    ),
    inputSpec: memberPresentationDraft(initialMember, "inputSpec", "displayInputSpec"),
    outputSpec: memberPresentationDraft(initialMember, "outputSpec", "displayOutputSpec"),
    contextTokenBudget: initialMember?.contextTokenBudget ? String(initialMember.contextTokenBudget) : "",
  };
}

function memberPresentationDraft(
  member: RoomMember | undefined,
  canonicalField: "name" | "role" | "publicDescription" | "inputSpec" | "outputSpec",
  displayField: "displayName" | "displayRole" | "displayPublicDescription" | "displayInputSpec" | "displayOutputSpec",
): string {
  if (!member) return "";
  if (member.userOverrides?.includes(canonicalField)) return member[canonicalField] ?? "";
  return member[displayField]?.trim() || member[canonicalField] || "";
}

function defaultEmployeeName(kernel: KernelOption | undefined): string {
  return kernel?.label?.trim() || "";
}

function employeeKernelRuntimeDraft(draft: EmployeeDraft): EmployeeKernelRuntimeDraft {
  return {
    model: draft.model,
    providerId: draft.providerId,
    reasoningEffort: draft.reasoningEffort,
  };
}

function employeeReasoningOverrideDraft(member: RoomMember | undefined): ReasoningEffort | "" {
  if (!member) return "";
  if (!member.manifestDefaults) return member.reasoningEffort ?? "";
  return member.userOverrides?.includes("reasoningEffort") ? (member.reasoningEffort ?? "") : "";
}

function shouldReplaceDefaultEmployeeName(currentName: string, previousKernelLabel: string | undefined): boolean {
  const trimmed = currentName.trim();
  return !trimmed || trimmed === previousKernelLabel;
}

export function createMemberFromDraft(
  draft: EmployeeDraft,
  params: { base?: RoomMember; initialMember?: RoomMember },
): RoomMember {
  const base = params.base;
  const contextTokenBudget = positiveTokenBudget(draft.contextTokenBudget);
  return {
    ...base,
    ...params.initialMember,
    id: draft.id,
    name: canonicalPresentationDraft(draft.name, params.initialMember?.displayName, params.initialMember?.name),
    kernel: draft.kernel,
    model: normalizeRoomMemberModelForKernel(draft.kernel, draft.model.trim() || base?.model || DEFAULT_MODEL_ID),
    providerId: draft.providerId || undefined,
    reasoningEffort: draft.reasoningEffort || undefined,
    accessMode: draft.accessMode,
    role: canonicalPresentationDraft(draft.role, params.initialMember?.displayRole, params.initialMember?.role),
    status: params.initialMember?.status || "waiting",
    color: params.initialMember?.color || base?.color || KERNEL_COLORS[draft.kernel] || "#64748b",
    lastActive: params.initialMember?.lastActive || "待命",
    avatarMode: draft.avatarMode,
    avatarSeed: draft.avatarMode === "generated" ? optionalDraftText(draft.avatarSeed) : undefined,
    avatarDataUrl: draft.avatarMode === "upload" ? optionalDraftText(draft.avatarDataUrl) : undefined,
    source: params.initialMember?.source ?? "local",
    sourceLabel: params.initialMember?.sourceLabel ?? roomMemberSourceLabel({ source: "local" }),
    visibility: draft.visibility,
    publicDescription: optionalDraftText(
      canonicalPresentationDraft(
        draft.publicDescription,
        params.initialMember?.displayPublicDescription,
        params.initialMember?.publicDescription,
      ),
    ),
    publicSkills:
      draft.publicSkillsText.trim() === publicSkillsText(params.initialMember?.displayPublicSkills)
        ? params.initialMember?.publicSkills
        : parsePublicSkillsText(draft.publicSkillsText),
    inputSpec: optionalDraftText(
      canonicalPresentationDraft(
        draft.inputSpec,
        params.initialMember?.displayInputSpec,
        params.initialMember?.inputSpec,
      ),
    ),
    outputSpec: optionalDraftText(
      canonicalPresentationDraft(
        draft.outputSpec,
        params.initialMember?.displayOutputSpec,
        params.initialMember?.outputSpec,
      ),
    ),
    contextTokenBudget,
  };
}

function draftPreviewMember(draft: EmployeeDraft, initialMember: RoomMember | undefined): RoomMember {
  return {
    ...initialMember,
    id: draft.id,
    employeeDefinitionId: initialMember?.employeeDefinitionId,
    name: draft.name || "?",
    kernel: draft.kernel,
    model: draft.model,
    providerId: draft.providerId || undefined,
    role: draft.role,
    status: "idle",
    color: KERNEL_COLORS[draft.kernel] || "#64748b",
    lastActive: "",
    avatarMode: draft.avatarMode,
    avatarSeed: optionalDraftText(draft.avatarSeed),
    avatarDataUrl: draft.avatarMode === "upload" ? draft.avatarDataUrl : undefined,
    source: initialMember?.source ?? "local",
  };
}

function hasLegacyInvalidAvatar(member: RoomMember | undefined): boolean {
  return member?.avatarMode === "upload" && !isSupportedRoomMemberAvatarDataUrl(member.avatarDataUrl);
}

function employeeDraftSourceSignature(member: RoomMember | undefined): string {
  if (!member) return "";
  return JSON.stringify({
    id: member.id,
    name: member.name,
    displayName: member.displayName,
    employeeDefinitionId: member.employeeDefinitionId,
    avatarMode: member.avatarMode,
    avatarSeed: member.avatarSeed,
    avatarDataUrl: member.avatarDataUrl,
    kernel: member.kernel,
    model: member.model,
    providerId: member.providerId,
    reasoningEffort: member.reasoningEffort,
    accessMode: member.accessMode,
    role: member.role,
    displayRole: member.displayRole,
    visibility: member.visibility,
    publicDescription: member.publicDescription,
    displayPublicDescription: member.displayPublicDescription,
    publicSkills: member.publicSkills,
    displayPublicSkills: member.displayPublicSkills,
    inputSpec: member.inputSpec,
    displayInputSpec: member.displayInputSpec,
    outputSpec: member.outputSpec,
    displayOutputSpec: member.displayOutputSpec,
    contextTokenBudget: member.contextTokenBudget,
  });
}

function consumeEmployeeAutosaveEcho(pendingMembers: RoomMember[], member: RoomMember | undefined): boolean {
  if (!member) return false;
  const memberSignature = employeeDraftSourceSignature(member);
  const matchIndex = pendingMembers.findLastIndex(
    (expected) => employeeDraftSourceSignature(expected) === memberSignature,
  );
  if (matchIndex < 0) return false;
  pendingMembers.splice(0, matchIndex + 1);
  return true;
}

function handleRadioGroupKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const group = event.currentTarget.closest('[role="radiogroup"]');
  if (!group) return;
  const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'));
  const currentIndex = radios.indexOf(event.currentTarget);
  if (currentIndex < 0 || radios.length < 2) return;
  event.preventDefault();
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? radios.length - 1
        : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + radios.length) %
          radios.length;
  const next = radios[nextIndex];
  next?.focus();
  next?.click();
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

export function employeeProviderSelection(
  kernelId: string,
  modelId: string,
  providers: ProviderProfile[],
  modelBindings: ModelProviderBinding[],
  kernel: KernelOption | undefined,
  currentProviderId: string,
  t: TranslationFn,
): { options: Array<{ id: string; label: string }>; defaultProviderId: string } {
  const candidates = new Map<string, { label: string; preferred: boolean }>();
  for (const provider of providers) {
    const providerId = providerRouteIdForKernel(provider, kernelId);
    if (
      !isProviderUsable(provider) ||
      !providerSupportsKernel(provider, kernelId) ||
      !providerServesModel(provider, kernelId, modelId, providers)
    )
      continue;
    const providerModels = provider.models ?? [];
    const model = providerModels.find((candidate) => modelOptionServesSelection(candidate, modelId));
    const existing = candidates.get(providerId);
    candidates.set(providerId, {
      label: providerDisplayName(provider, t),
      preferred: existing?.preferred === true || model?.defaultProviderId === provider.id,
    });
  }
  const configuredProviderId = modelBindings.find((binding) =>
    modelIdsEquivalent(binding.modelId, modelId, providers, binding.providerId),
  )?.providerId;
  const configuredProvider = providers.find((provider) => provider.id === configuredProviderId);
  const configuredDefaultId =
    configuredProvider && providerSupportsKernel(configuredProvider, kernelId)
      ? providerRouteIdForKernel(configuredProvider, kernelId)
      : configuredProviderId;
  const defaultId = configuredDefaultId;
  const defaultLabel = defaultId
    ? candidates.get(defaultId)?.label ||
      providers.find((provider) => provider.id === configuredProviderId)?.name ||
      defaultId
    : kernel?.providerLabel;
  if (configuredDefaultId && !candidates.has(configuredDefaultId)) {
    candidates.set(configuredDefaultId, {
      label: `${defaultLabel || configuredDefaultId} (${t("common.unavailable")})`,
      preferred: false,
    });
  }
  if (currentProviderId && !candidates.has(currentProviderId)) {
    const currentProvider = providers.find((provider) => provider.id === currentProviderId);
    candidates.set(currentProviderId, {
      label: `${currentProvider?.name || currentProviderId} (${t("common.unavailable")})`,
      preferred: false,
    });
  }
  return {
    defaultProviderId: defaultId || "",
    options: [
      ...(!defaultId ? [{ id: "", label: t("employee.providerRequired") }] : []),
      ...[...candidates.entries()]
        .sort((left, right) => left[1].label.localeCompare(right[1].label))
        .map(([id, candidate]) => ({
          id,
          label: id === defaultId ? t("employee.providerDefaultBadge", { provider: candidate.label }) : candidate.label,
        })),
    ],
  };
}

export function employeeModelOptions(
  kernelId: string,
  runtimeControls: RuntimeControls | undefined,
  providers: ProviderProfile[],
) {
  const options = [];
  if (runtimeControls) {
    for (const model of modelOptionsForKernel(kernelId, runtimeControls)) {
      if (!model.id?.trim()) continue;
      options.push(model);
    }
  }
  for (const provider of providers) {
    if (!isProviderUsable(provider) || !providerSupportsKernel(provider, kernelId)) continue;
    for (const model of provider.models ?? []) {
      if (!model.id?.trim()) continue;
      options.push(model);
    }
  }
  return collapseModelOptions(options);
}

export function includeUnavailableEmployeeModelOption(
  options: Array<{ id: string; label: string; description?: string }>,
  currentModelId: string,
  unavailableLabel: string,
): Array<{ id: string; label: string; description?: string }> {
  const normalizedModelId = currentModelId.trim();
  if (!normalizedModelId || options.some((option) => modelOptionMatchesId(option, normalizedModelId))) return options;
  return [
    {
      id: normalizedModelId,
      label: `${normalizedModelId} (${unavailableLabel})`,
    },
    ...options,
  ];
}

function reasoningOptionsForRuntime(
  controls: RuntimeControls | undefined,
  t: ReturnType<typeof useI18n>["t"],
): Array<{ id: ReasoningEffort; label: string }> {
  return (controls?.reasoningEfforts ?? [])
    .filter((option): option is { id: ReasoningEffort; label: string } => isReasoningEffort(option.id))
    .map((option) => ({
      id: option.id,
      label: t(REASONING_EFFORT_LABEL_KEYS[option.id]),
    }));
}

// ===== Reasoning capability state =====

type EmployeeReasoningControl =
  | { status: "loading"; value: ReasoningEffort; options: Array<{ id: ReasoningEffort; label: string }> }
  | { status: "supported"; value: ReasoningEffort; options: Array<{ id: ReasoningEffort; label: string }> }
  | { status: "unsupported"; options: [] };

// Runtime controls are absent only while capability discovery is pending; the Host executes an unset effort as medium.
const HOST_FALLBACK_REASONING_EFFORT: ReasoningEffort = "medium";

function employeeReasoningControl(
  controls: RuntimeControls | undefined,
  persistedEffort: ReasoningEffort | "",
  appDefaultEffort: ReasoningEffort | "",
  t: ReturnType<typeof useI18n>["t"],
): EmployeeReasoningControl {
  if (!controls) {
    const value = persistedEffort || appDefaultEffort || HOST_FALLBACK_REASONING_EFFORT;
    return {
      status: "loading",
      value,
      options: [{ id: value, label: t(REASONING_EFFORT_LABEL_KEYS[value]) }],
    };
  }
  const options = reasoningOptionsForRuntime(controls, t);
  if (!options.length) return { status: "unsupported", options: [] };
  const compatibleAppDefault =
    appDefaultEffort && options.some((option) => option.id === appDefaultEffort) ? appDefaultEffort : "";
  const value =
    persistedEffort ||
    compatibleAppDefault ||
    defaultReasoningEffort(controls, options) ||
    HOST_FALLBACK_REASONING_EFFORT;
  return {
    status: "supported",
    value,
    options:
      persistedEffort && !options.some((option) => option.id === persistedEffort)
        ? [...options, { id: persistedEffort, label: t(REASONING_EFFORT_LABEL_KEYS[persistedEffort]) }]
        : options,
  };
}

const REASONING_EFFORT_LABEL_KEYS: Record<ReasoningEffort, TranslationKey> = {
  low: "composer.effortLow",
  medium: "composer.effortMedium",
  high: "composer.effortHigh",
  xhigh: "composer.effortXHigh",
  max: "composer.effortMax",
};

function defaultReasoningEffort(
  controls: RuntimeControls | undefined,
  options: Array<{ id: ReasoningEffort }>,
): ReasoningEffort | "" {
  const declaredDefault = controls?.defaultReasoningEffort;
  if (
    declaredDefault &&
    isReasoningEffort(declaredDefault) &&
    options.some((option) => option.id === declaredDefault)
  ) {
    return declaredDefault;
  }
  return options.find((option) => option.id === "medium")?.id ?? options[0]?.id ?? "";
}

function positiveTokenBudget(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function previewSubtitle(
  draft: EmployeeDraft,
  kernelLabel: string | undefined,
  modelLabelText: string | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  return `${kernelLabel || draft.kernel || t("employee.chooseKernelFallback")} / ${modelLabelText || draft.model || DEFAULT_MODEL_ID}`;
}

function resolveDefaultModel(
  kernelId: string,
  activeKernel: string | undefined,
  activeModel: ModelId,
  runtimeControls: RuntimeControls | undefined,
  runtimeControlsByKernel: Record<string, RuntimeControls> | undefined,
  providers?: ProviderProfile[],
): string {
  const controls = runtimeControlsForKernel(kernelId, runtimeControls, runtimeControlsByKernel);
  const options = providers ? employeeModelOptions(kernelId, controls, providers) : undefined;
  if (options && !options.length) return "";
  return resolveDefaultModelForKernel({
    kernelId,
    activeKernel,
    activeModel,
    runtimeControls,
    runtimeControlsByKernel,
    options,
  });
}

function publicSkillsText(values: string[] | undefined): string {
  return (values ?? []).join("\n");
}

function canonicalPresentationDraft(
  draft: string,
  presentation: string | undefined,
  canonical: string | undefined,
): string {
  return presentation && draft.trim() === presentation.trim() ? (canonical?.trim() ?? "") : draft.trim();
}

function parsePublicSkillsText(value: string): string[] {
  return normalizeSkillIds(value.split(/[\n,，]/g));
}

function optionalDraftText(value: string): string | undefined {
  const text = value.trim();
  return text ? text : undefined;
}
