import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ExtensionItemCollection,
  KernelOption,
  ModelId,
  ModelProviderBinding,
  ProviderProfile,
  RuntimeControls,
  SkillRecord,
} from "../../bridge";
import { useI18n, type TranslationKey } from "../../i18n";
import { localeForLanguage } from "../../locale";
import { useConfirm } from "../ui/confirm-dialog";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { ProductIcon } from "../ui/product-icon";
import { useToast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import {
  buildContactSkillOptions,
  buildMemberActivitySnapshot,
  appEmployeeOverrideItems,
  canEditEmployeeRuntime,
  effectiveMemberAvailableSkillIds,
  effectiveMemberSkillIds,
  normalizeSkillIds,
  type AppEmployeeOverrideItem,
  type ContactSkillOption,
  type EmployeeDetailPage,
} from "./contacts-model";
import { EmployeeAvatarPicker } from "./employee-avatar-picker";
import { EmployeeDialog, type EmployeeEditorTab } from "./employee-dialog";
import { RoomMemberAvatar } from "./member-avatar";
import type { Room, RoomMember } from "./rooms-model";
import { roomMemberDisplayName } from "./rooms-model";
import { useEmployeeSettingsAutosave, type EmployeeSettingsPatchOptions } from "./use-employee-settings-autosave";
import "./contacts-view.css";

export type EmployeeSettingsSurfaceProps = {
  member: RoomMember;
  rooms: Room[];
  activeKernel?: string;
  activeModel: ModelId;
  extensions?: ExtensionItemCollection;
  kernelOptions: KernelOption[];
  providers: ProviderProfile[] | undefined;
  modelProviderBindings: ModelProviderBinding[] | undefined;
  providerRoutingEnabled?: boolean;
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  skills?: SkillRecord[];
  publishPending?: boolean;
  onMessage?(): void;
  onPublish?(): unknown | Promise<unknown>;
  onDelete?(): void;
  onRestoreAppDefaults?(): unknown | Promise<unknown>;
  onSave(member: RoomMember): unknown | Promise<unknown>;
};

export type EmployeeSettingsDialogProps = EmployeeSettingsSurfaceProps & {
  open: boolean;
  onOpenChange(open: boolean): void;
};

export function EmployeeSettingsDialog(props: EmployeeSettingsDialogProps) {
  const { t } = useI18n();
  const { open, onOpenChange, ...surfaceProps } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="employee-settings-dialog" aria-label={t("employee.profileSettingsTitle")}>
        <DialogTitle className="employee-settings-dialog-title">{t("employee.profileSettingsTitle")}</DialogTitle>
        <Tooltip content={t("mountedApp.close")} side="left">
          <button
            className="employee-settings-dialog-close"
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t("mountedApp.close")}
          >
            <ProductIcon name="close" size={18} />
          </button>
        </Tooltip>
        <EmployeeSettingsSurface {...surfaceProps} />
      </DialogContent>
    </Dialog>
  );
}

export function EmployeeSettingsSurface(props: EmployeeSettingsSurfaceProps) {
  const { language, t } = useI18n();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [employeePage, setEmployeePage] = useState<EmployeeDetailPage>("overview");
  const [managingSkills, setManagingSkills] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [directSaving, setDirectSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(() => roomMemberDisplayName(props.member));
  const cancelNameBlurRef = useRef(false);
  const lastAutosaveErrorRef = useRef("");
  const autosave = useEmployeeSettingsAutosave({
    member: props.member,
    onSave: props.onSave,
  });
  const member = autosave.member;
  const memberDisplayName = roomMemberDisplayName(member);
  const saving = directSaving || autosave.saving;

  useEffect(() => {
    setEmployeePage("overview");
    setManagingSkills(false);
    setSkillQuery("");
    setAvatarPickerOpen(false);
  }, [props.member.id]);

  useEffect(() => {
    setNameDraft(memberDisplayName);
  }, [memberDisplayName, props.member.id]);

  useEffect(() => {
    if (!autosave.error) {
      lastAutosaveErrorRef.current = "";
      return;
    }
    if (lastAutosaveErrorRef.current === autosave.error) return;
    lastAutosaveErrorRef.current = autosave.error;
    toast({
      kind: "error",
      title: t("contacts.saveFailed", { message: autosave.error }),
      action: {
        label: t("common.retry"),
        onClick: autosave.retry,
      },
    });
  }, [autosave.error, autosave.retry, t, toast]);

  const canEditRuntime = canEditEmployeeRuntime(member);
  const appOverrideItems = appEmployeeOverrideItems(member);
  const appOverrideCount = appOverrideItems.length;
  const appOverrideLabels = appOverrideItems.map((item) => t(APP_EMPLOYEE_OVERRIDE_ITEM_LABEL_KEYS[item]));
  const activity = useMemo(() => buildMemberActivitySnapshot(member, props.rooms, t), [member, props.rooms, t]);
  const skillOptions = useMemo(
    () => buildContactSkillOptions(props.skills ?? [], props.extensions, t),
    [props.extensions, props.skills, t],
  );
  const skillOptionsById = useMemo(() => new Map(skillOptions.map((skill) => [skill.id, skill])), [skillOptions]);
  const effectiveSkillIds = useMemo(() => effectiveMemberSkillIds(member, skillOptions), [member, skillOptions]);
  const availableSkillIds = useMemo(
    () => effectiveMemberAvailableSkillIds(member, skillOptions),
    [member, skillOptions],
  );
  const effectiveSkills = useMemo(
    () =>
      effectiveSkillIds
        .map((skillId) => skillOptionsById.get(skillId))
        .filter((skill): skill is ContactSkillOption => Boolean(skill)),
    [effectiveSkillIds, skillOptionsById],
  );
  const availableSkills = useMemo(
    () =>
      availableSkillIds
        .map((skillId) => skillOptionsById.get(skillId))
        .filter((skill): skill is ContactSkillOption => Boolean(skill)),
    [availableSkillIds, skillOptionsById],
  );
  const toolIds = useMemo(
    () =>
      normalizeSkillIds([
        ...(member.toolIds ?? []),
        ...availableSkills.flatMap((skill) => [...skill.toolIds, ...skill.allowedTools]),
      ]),
    [availableSkills, member.toolIds],
  );
  const filteredSkillOptions = useMemo(() => {
    const value = skillQuery.trim().toLowerCase();
    if (!value) return skillOptions;
    return skillOptions.filter(
      (skill) =>
        skill.name.toLowerCase().includes(value) ||
        skill.title.toLowerCase().includes(value) ||
        skill.description.toLowerCase().includes(value) ||
        skill.sourceLabel.toLowerCase().includes(value),
    );
  }, [skillOptions, skillQuery]);

  const employeePageTitle =
    employeePage === "activity"
      ? t("contacts.tabActivity")
      : employeePage === "capabilities"
        ? t("contacts.tabCapabilities")
        : employeePage === "collaboration"
          ? t("employee.responsibilityTitle")
          : "";

  function queueMemberPatch(patch: Partial<RoomMember>, options: EmployeeSettingsPatchOptions = { immediate: true }) {
    autosave.enqueuePatch(patch, options);
  }

  async function openEmployeePage(page: EmployeeDetailPage) {
    if (!(await autosave.flush())) return;
    setEmployeePage(page);
  }

  function applyMemberPatch(patch: Partial<RoomMember>) {
    queueMemberPatch(patch, { immediate: true });
  }

  function saveName() {
    const nextName = nameDraft.trim();
    const currentName = memberDisplayName;
    if (!nextName) {
      setNameDraft(currentName);
      return;
    }
    if (nextName === currentName) return;
    queueMemberPatch({ name: nextName }, { immediate: true });
  }

  async function restoreAppDefaults() {
    if (!props.onRestoreAppDefaults || directSaving) return;
    if (!(await autosave.flush())) return;
    const confirmed = await confirm({
      title: t("contacts.restoreAppDefaultsConfirmTitle"),
      body: t("contacts.restoreAppDefaultsConfirmBody", {
        changes: new Intl.ListFormat(localeForLanguage(language), {
          style: "long",
          type: "conjunction",
        }).format(appOverrideLabels),
        count: appOverrideCount,
      }),
      confirmLabel: t("contacts.restoreAppDefaultsConfirmAction"),
      danger: true,
    });
    if (confirmed !== "primary") return;
    setDirectSaving(true);
    try {
      await props.onRestoreAppDefaults();
      toast({
        kind: "success",
        title: t("contacts.appDefaultsRestoredNextRun"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        kind: "error",
        title: t("contacts.saveFailed", { message }),
        action: {
          label: t("common.retry"),
          onClick: () => void restoreAppDefaults(),
        },
      });
    } finally {
      setDirectSaving(false);
    }
  }

  function toggleAvailableSkill(skillId: string) {
    if (!canEditRuntime || directSaving) return;
    const nextSkillIds = availableSkillIds.includes(skillId)
      ? availableSkillIds.filter((id) => id !== skillId)
      : [...availableSkillIds, skillId];
    applyMemberPatch({
      availableSkillIds: normalizeSkillIds(nextSkillIds),
      defaultSkillIds: effectiveSkillIds.filter((id) => nextSkillIds.includes(id)),
    });
  }

  function toggleRequiredSkill(skillId: string) {
    if (!canEditRuntime || directSaving) return;
    const nextRequired = effectiveSkillIds.includes(skillId)
      ? effectiveSkillIds.filter((id) => id !== skillId)
      : [...effectiveSkillIds, skillId];
    applyMemberPatch({
      availableSkillIds: normalizeSkillIds([...availableSkillIds, skillId]),
      defaultSkillIds: normalizeSkillIds(nextRequired),
    });
  }

  function removeDefaultSkill(skillId: string) {
    if (!canEditRuntime || directSaving) return;
    applyMemberPatch({
      defaultSkillIds: effectiveSkillIds.filter((id) => id !== skillId),
    });
  }

  async function publishMember() {
    if (!props.onPublish || publishing || props.publishPending) return;
    if (!(await autosave.flush())) return;
    setPublishing(true);
    try {
      await props.onPublish();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        kind: "error",
        title: t("contacts.publishFailed", { message }),
        action: {
          label: t("common.retry"),
          onClick: () => void publishMember(),
        },
      });
    } finally {
      setPublishing(false);
    }
  }

  function renderEmployeeEditor(tab: EmployeeEditorTab) {
    return (
      <EmployeeDialog
        embedded
        open
        activeTab={tab}
        activeKernel={props.activeKernel}
        activeModel={props.activeModel}
        runtimeControls={props.runtimeControls}
        runtimeControlsByKernel={props.runtimeControlsByKernel}
        kernelOptions={props.kernelOptions}
        providers={props.providers}
        modelProviderBindings={props.modelProviderBindings}
        providerRoutingEnabled={props.providerRoutingEnabled}
        initialMember={member}
        showTabs={false}
        showPreview={false}
        showCancel={false}
        showRuntimeNote={employeePage !== "overview"}
        showSubmitActions={false}
        onDraftPatch={queueMemberPatch}
        onOpenChange={() => undefined}
        onCreate={() => undefined}
      />
    );
  }

  return (
    <section className="contacts-employee-settings-surface" aria-label={t("contacts.employeeProfile")}>
      <div className="contacts-employee-body">
        {employeePage === "overview" ? (
          <section className="contacts-employee-summary" aria-label={t("contacts.employeeOverview")}>
            {appOverrideCount > 0 && props.onRestoreAppDefaults ? (
              <button
                className="contacts-employee-restore-defaults-button"
                type="button"
                disabled={saving}
                onClick={() => void restoreAppDefaults()}
              >
                <ProductIcon name="refresh" size={15} />
                <span>{t("contacts.restoreAppDefaults")}</span>
              </button>
            ) : null}
            <div className="contacts-employee-identity">
              <Tooltip content={t("employee.avatarTitle")}>
                <button
                  className="contacts-avatar-editor contacts-employee-avatar"
                  type="button"
                  disabled={!canEditRuntime}
                  onClick={() => setAvatarPickerOpen(true)}
                  aria-label={t("employee.avatarTitle")}
                >
                  <RoomMemberAvatar member={member} />
                  {canEditRuntime ? (
                    <span className="contacts-avatar-editor-badge" aria-hidden="true">
                      <ProductIcon name="camera" size={14} />
                    </span>
                  ) : null}
                </button>
              </Tooltip>
              <div className="contacts-employee-title">
                {canEditRuntime ? (
                  <input
                    value={nameDraft}
                    disabled={directSaving}
                    data-dialog-escape-stays-open="true"
                    aria-label={t("employee.nameLabel")}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={() => {
                      if (cancelNameBlurRef.current) {
                        cancelNameBlurRef.current = false;
                        return;
                      }
                      void saveName();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        event.nativeEvent.stopImmediatePropagation();
                        cancelNameBlurRef.current = true;
                        setNameDraft(memberDisplayName);
                        event.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <h3>{memberDisplayName}</h3>
                )}
              </div>
            </div>
            <div className="contacts-detail-actions contacts-summary-actions">
              {props.onMessage ? (
                <Tooltip content={t("contacts.sendMessage")}>
                  <button
                    className="contacts-message-button"
                    type="button"
                    onClick={props.onMessage}
                    aria-label={t("contacts.sendMessage")}
                  >
                    <span className="contacts-summary-action-icon" aria-hidden="true">
                      <ProductIcon name="chat" size={17} />
                    </span>
                  </button>
                </Tooltip>
              ) : null}
              {canEditRuntime && props.onPublish ? (
                <Tooltip
                  content={
                    publishing || props.publishPending
                      ? t("contacts.publishing")
                      : t("settings.extensionPublishToKernel")
                  }
                >
                  <button
                    className="contacts-message-button"
                    type="button"
                    onClick={() => void publishMember()}
                    disabled={publishing || props.publishPending}
                    aria-label={
                      publishing || props.publishPending
                        ? t("contacts.publishing")
                        : t("settings.extensionPublishToKernel")
                    }
                  >
                    <span className="contacts-summary-action-icon" aria-hidden="true">
                      <ProductIcon name="upload" size={16} />
                    </span>
                  </button>
                </Tooltip>
              ) : null}
              {canEditRuntime && props.onDelete ? (
                <Tooltip content={t("common.delete")}>
                  <button
                    className="contacts-message-button danger"
                    type="button"
                    onClick={props.onDelete}
                    aria-label={t("common.delete")}
                  >
                    <span className="contacts-summary-action-icon" aria-hidden="true">
                      <ProductIcon name="delete" size={16} />
                    </span>
                  </button>
                </Tooltip>
              ) : null}
            </div>
          </section>
        ) : (
          <header className="contacts-employee-subpage-header">
            <Tooltip content={t("contacts.backToEmployeeOverview")} side="right">
              <button
                type="button"
                onClick={() => void openEmployeePage("overview")}
                aria-label={t("contacts.backToEmployeeOverview")}
              >
                <ProductIcon name="back" size={20} />
              </button>
            </Tooltip>
            <h2>{employeePageTitle}</h2>
          </header>
        )}

        <div className="contacts-employee-console">
          <div className="contacts-console-body">
            {employeePage === "overview" ? (
              <section className="contacts-employee-overview-page" aria-label={t("contacts.employeeOverview")}>
                <section className="contacts-employee-activity-preview" aria-label={t("contacts.tabActivity")}>
                  <button
                    className="contacts-employee-activity-summary"
                    type="button"
                    onClick={() => void openEmployeePage("activity")}
                  >
                    <span className="contacts-employee-activity-card-action" aria-hidden="true">
                      <ProductIcon name="next" size={18} />
                    </span>
                    <div
                      className="contacts-employee-activity-current"
                      data-active={activity.currentWork ? "true" : "false"}
                    >
                      <span className="contacts-employee-activity-current-status" aria-hidden="true">
                        <ProductIcon name={activity.currentWork ? "loading" : "ops"} size={18} />
                      </span>
                      <strong>{activity.currentWork || t("contacts.noOngoingWork")}</strong>
                    </div>
                    <div className="contacts-employee-activity-metrics">
                      <span>
                        <strong>{activity.totalRuns}</strong>
                        <small>{t("contacts.activityRuns30d")}</small>
                      </span>
                      <span>
                        <strong>{activity.successRate}%</strong>
                        <small>{t("contacts.activitySuccessRate")}</small>
                      </span>
                      <span>
                        <strong>{activity.averageDuration || "—"}</strong>
                        <small>{t("contacts.activityAverageDuration")}</small>
                      </span>
                    </div>
                  </button>
                </section>
                <section className="contacts-employee-runtime-card" aria-label={t("employee.runtimeSettingsTitle")}>
                  <div className="contacts-shared-employee-editor contacts-employee-overview-runtime-editor">
                    {renderEmployeeEditor("runtime")}
                  </div>
                </section>
                <div className="contacts-employee-overview-group">
                  <EmployeeOverviewRow
                    icon="extensions"
                    label={t("contacts.tabCapabilities")}
                    onClick={() => void openEmployeePage("capabilities")}
                  />
                  <EmployeeOverviewRow
                    icon="rooms"
                    label={t("employee.responsibilityTitle")}
                    onClick={() => void openEmployeePage("collaboration")}
                  />
                </div>
              </section>
            ) : null}

            {employeePage === "collaboration" ? (
              <div className="contacts-shared-employee-editor">{renderEmployeeEditor("collaboration")}</div>
            ) : null}

            {employeePage === "activity" ? (
              <section className="contacts-console-section" aria-label={t("contacts.employeeActivity")}>
                <div className="contacts-activity-card quiet">
                  <strong>{t("common.current")}</strong>
                  <span>{activity.currentWork || t("contacts.noOngoingWork")}</span>
                </div>
                <div className="contacts-activity-card metric">
                  <span>{t("contacts.performance30d")}</span>
                  <strong>{activity.totalRuns}</strong>
                  <p>
                    {t("contacts.performanceSummary", {
                      successRate: activity.successRate,
                      averageDuration: activity.averageDuration || "-",
                      failedRuns: activity.failedRuns,
                    })}
                  </p>
                </div>
                <div className="contacts-activity-card">
                  <strong>{t("contacts.recentActivity")}</strong>
                  {activity.recentRuns.length ? (
                    <div className="contacts-recent-run-list">
                      {activity.recentRuns.map((run) => (
                        <div key={run.id} className="contacts-recent-run" data-status={run.status}>
                          <span aria-hidden="true">
                            <ProductIcon
                              name={
                                run.status === "running"
                                  ? "loading"
                                  : run.status === "failed" || run.status === "interrupted"
                                    ? "error"
                                    : run.status === "done"
                                      ? "success"
                                      : "send"
                              }
                              size={19}
                            />
                          </span>
                          <div>
                            <strong>{run.title}</strong>
                            <small>
                              {run.createdAt} · {run.duration || t("contacts.unknownDuration")} · {run.statusLabel}
                            </small>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="contacts-capability-empty">{t("contacts.noEmployeeRuns")}</div>
                  )}
                </div>
              </section>
            ) : null}

            {employeePage === "capabilities" ? (
              <section
                className="contacts-console-section contacts-skill-section contacts-capability-page"
                aria-label={t("contacts.employeeCapabilities")}
              >
                <section className="contacts-capability-section">
                  <div className="contacts-capability-section-heading">
                    <h3>{t("settings.extensionKindSkill")}</h3>
                    {canEditRuntime ? (
                      <button type="button" onClick={() => setManagingSkills((open) => !open)}>
                        <ProductIcon name={managingSkills ? "success" : "edit"} size={16} />
                        {managingSkills ? t("contacts.collapse") : t("contacts.manageSkills")}
                      </button>
                    ) : null}
                  </div>
                  <div className="contacts-capability-card">
                    {managingSkills && canEditRuntime ? (
                      <>
                        <div className="contacts-skill-toolbar">
                          <label className="contacts-skill-search">
                            <ProductIcon name="search" size={15} />
                            <input
                              value={skillQuery}
                              onChange={(event) => setSkillQuery(event.target.value)}
                              placeholder={t("contacts.searchSkillPlaceholder")}
                            />
                          </label>
                          <div className="contacts-skill-batch-actions">
                            <button
                              type="button"
                              disabled={directSaving}
                              onClick={() =>
                                applyMemberPatch({
                                  availableSkillIds: normalizeSkillIds(
                                    member.manifestDefaults?.availableSkillIds ?? member.defaultSkillIds,
                                  ),
                                  defaultSkillIds: normalizeSkillIds(
                                    member.manifestDefaults?.defaultSkillIds ?? member.defaultSkillIds,
                                  ),
                                })
                              }
                            >
                              <ProductIcon name="refresh" size={15} />
                              <span>{t("contacts.resetAvailable")}</span>
                            </button>
                            <button
                              type="button"
                              disabled={directSaving}
                              onClick={() =>
                                applyMemberPatch({
                                  availableSkillIds: normalizeSkillIds(skillOptions.map((skill) => skill.id)),
                                })
                              }
                            >
                              <ProductIcon name="success" size={15} />
                              <span>{t("contacts.allAvailable")}</span>
                            </button>
                            <button
                              type="button"
                              disabled={directSaving}
                              onClick={() => applyMemberPatch({ availableSkillIds: [], defaultSkillIds: [] })}
                            >
                              <ProductIcon name="close" size={15} />
                              <span>{t("commands.clearTitle")}</span>
                            </button>
                          </div>
                        </div>
                        <div className="contacts-skill-picker" aria-label={t("contacts.skillPickerLabel")}>
                          {filteredSkillOptions.map((skill) => {
                            const available = availableSkillIds.includes(skill.id);
                            const required = effectiveSkillIds.includes(skill.id);
                            return (
                              <div
                                className="contacts-skill-option"
                                data-selected={available ? "true" : "false"}
                                key={skill.id}
                              >
                                <span className="contacts-capability-row-icon" aria-hidden="true">
                                  <ProductIcon name="extensions" size={18} />
                                </span>
                                <span className="contacts-skill-copy">
                                  <strong>{skill.title || skill.name}</strong>
                                  <small>
                                    {skill.description || t("contacts.skillCommandFallback", { name: skill.name })}
                                  </small>
                                </span>
                                <span className="contacts-skill-mode-controls">
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={available}
                                      disabled={directSaving}
                                      onChange={() => toggleAvailableSkill(skill.id)}
                                    />
                                    <span>{available ? <ProductIcon name="success" size={12} /> : null}</span>
                                    {t("common.available")}
                                  </label>
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={required}
                                      disabled={directSaving}
                                      onChange={() => toggleRequiredSkill(skill.id)}
                                    />
                                    <span>{required ? <ProductIcon name="success" size={12} /> : null}</span>
                                    {t("contacts.skillRequired")}
                                  </label>
                                </span>
                              </div>
                            );
                          })}
                          {!filteredSkillOptions.length ? (
                            <div className="contacts-capability-empty">{t("contacts.noSelectableSkills")}</div>
                          ) : null}
                        </div>
                      </>
                    ) : effectiveSkills.length ? (
                      <div className="contacts-capability-list">
                        {effectiveSkills.map((skill) => (
                          <div className="contacts-capability-row" key={skill.id}>
                            <span className="contacts-capability-row-icon" aria-hidden="true">
                              <ProductIcon name="extensions" size={18} />
                            </span>
                            <span className="contacts-skill-copy">
                              <strong>{skill.title || skill.name}</strong>
                              <small>
                                {skill.description || t("contacts.skillCommandFallback", { name: skill.name })}
                              </small>
                            </span>
                            {canEditRuntime ? (
                              <Tooltip content={t("contacts.removeFromDefaultSkills")} side="left">
                                <button
                                  className="contacts-capability-row-action"
                                  type="button"
                                  onClick={() => removeDefaultSkill(skill.id)}
                                  aria-label={t("mountedApp.removeMember", { name: skill.title || skill.name })}
                                >
                                  <ProductIcon name="close" size={15} />
                                </button>
                              </Tooltip>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        className="contacts-capability-empty contacts-editable-panel"
                        role="button"
                        tabIndex={0}
                        onClick={() => setManagingSkills(true)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          setManagingSkills(true);
                        }}
                      >
                        {t("contacts.noDefaultSkillsHint")}
                      </div>
                    )}
                  </div>
                </section>

                <section className="contacts-capability-section">
                  <div className="contacts-capability-section-heading">
                    <h3>{t("settings.extensionKindTool")}</h3>
                  </div>
                  <div className="contacts-capability-card">
                    {toolIds.length ? (
                      <div className="contacts-capability-list">
                        {toolIds.map((toolId) => (
                          <div className="contacts-capability-row" key={toolId}>
                            <span className="contacts-capability-row-icon" aria-hidden="true">
                              <ProductIcon name="tools" size={18} />
                            </span>
                            <span className="contacts-skill-copy">
                              <strong>{toolId}</strong>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="contacts-capability-empty">{t("contacts.noToolsDeclared")}</div>
                    )}
                  </div>
                </section>
              </section>
            ) : null}
          </div>
        </div>
      </div>
      <EmployeeAvatarPicker
        open={avatarPickerOpen}
        member={{ ...member, name: nameDraft.trim() || member.name }}
        disabled={directSaving || !canEditRuntime}
        onOpenChange={setAvatarPickerOpen}
        onConfirm={(patch) => queueMemberPatch(patch, { immediate: true })}
      />
    </section>
  );
}

const APP_EMPLOYEE_OVERRIDE_ITEM_LABEL_KEYS = {
  name: "employee.nameLabel",
  avatar: "employee.avatarTitle",
  role: "employee.roleLabel",
  kernel: "contacts.executionKernel",
  model: "composer.model",
  availableSkills: "contacts.availableSkills",
  requiredSkills: "contacts.requiredSkills",
  reasoningEffort: "contacts.reasoningLevel",
  contextTokenBudget: "contacts.contextBudgetLabel",
  accessMode: "contacts.accessTitle",
  visibility: "contacts.visibility",
  publicDescription: "employee.publicDescriptionLabel",
  publicSkills: "employee.publicSkillsLabel",
  inputSpec: "employee.inputSpecLabel",
  outputSpec: "employee.outputSpecLabel",
} as const satisfies Record<AppEmployeeOverrideItem, TranslationKey>;

function EmployeeOverviewRow(props: {
  icon: "settings" | "extensions" | "rooms" | "refresh";
  label: string;
  disabled?: boolean;
  showNext?: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      <span className="contacts-employee-overview-icon" aria-hidden="true">
        <ProductIcon name={props.icon} size={19} />
      </span>
      <span className="contacts-employee-overview-copy">
        <strong>{props.label}</strong>
      </span>
      {props.showNext === false ? null : <ProductIcon name="next" size={18} />}
    </button>
  );
}
