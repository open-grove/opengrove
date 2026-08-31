import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useI18n } from "../../i18n";
import { employeeAvatarSeedForMember, EmployeeAvatar } from "../ui/employee-avatar";
import { Dialog, DialogContent, DialogSubpage, DialogTitle, useInsideDialogContent } from "../ui/dialog";
import { AnimatedBackground } from "../ui/motion/animated-background";
import { NameAvatarFallback } from "../ui/name-avatar";
import { ProductIcon } from "../ui/product-icon";
import {
  ROOM_MEMBER_AVATAR_MAX_BYTES,
  isSupportedRoomMemberAvatarDataUrl,
} from "../../../../src/rooms/avatar-data-url";
import { RoomMemberAvatar } from "./member-avatar";
import type { RoomMember, RoomMemberAvatarMode } from "./rooms-model";
import "./room-dialogs.css";

export type EmployeeAvatarPatch = Pick<RoomMember, "avatarMode" | "avatarSeed" | "avatarDataUrl">;

type EmployeeAvatarDraft = {
  mode: RoomMemberAvatarMode;
  seed: string;
  dataUrl: string;
};

export function EmployeeAvatarPicker(props: {
  open: boolean;
  member: RoomMember;
  disabled?: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(patch: EmployeeAvatarPatch): unknown | Promise<unknown>;
}) {
  const { t } = useI18n();
  const insideDialog = useInsideDialogContent();
  const [draft, setDraft] = useState<EmployeeAvatarDraft>(() => avatarDraftFromMember(props.member));
  const [avatarBatch, setAvatarBatch] = useState(0);
  const [error, setError] = useState(() => avatarErrorForMember(props.member, t));
  const [saving, setSaving] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const tabsId = useId();
  const memberSignature = employeeAvatarSignature(props.member);

  useEffect(() => {
    if (!props.open) return;
    setDraft(avatarDraftFromMember(props.member));
    setAvatarBatch(0);
    setError(avatarErrorForMember(props.member, t));
    setSaving(false);
  }, [memberSignature, props.open, t]);

  const defaultSeed = employeeAvatarSeedForMember(props.member);
  const avatarSeeds = useMemo(
    () => avatarSeedOptions(props.member.id, avatarBatch, draft.seed || defaultSeed),
    [avatarBatch, defaultSeed, draft.seed, props.member.id],
  );
  const previewMember = employeeAvatarPreviewMember(props.member, draft);

  function setMode(mode: RoomMemberAvatarMode) {
    setDraft((current) => ({
      mode,
      seed: mode === "generated" ? current.seed || avatarSeeds[0] || defaultSeed : current.seed,
      dataUrl: mode === "upload" ? current.dataUrl : "",
    }));
    setError("");
  }

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError(t("employee.avatarUploadTypeError"));
      return;
    }
    if (file.size > ROOM_MEMBER_AVATAR_MAX_BYTES) {
      setError(t("employee.avatarUploadSizeError"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setDraft((current) => ({
        ...current,
        mode: "upload",
        dataUrl: reader.result as string,
      }));
      setError("");
    };
    reader.readAsDataURL(file);
  }

  async function confirm() {
    if (saving || props.disabled || !avatarDraftIsValid(draft)) return;
    setSaving(true);
    try {
      await props.onConfirm({
        avatarMode: draft.mode,
        avatarSeed: draft.mode === "generated" ? draft.seed || undefined : undefined,
        avatarDataUrl: draft.mode === "upload" ? draft.dataUrl || undefined : undefined,
      });
      props.onOpenChange(false);
    } catch (saveError) {
      setError(
        t("contacts.saveFailed", {
          message: saveError instanceof Error ? saveError.message : String(saveError),
        }),
      );
    } finally {
      setSaving(false);
    }
  }

  const pickerLayout = (
    <div className="employee-avatar-picker-layout">
      <aside className="employee-avatar-picker-preview">
        <span>{t("appIcon.preview")}</span>
        <RoomMemberAvatar member={previewMember} showStatus={false} />
        <strong>{previewMember.name}</strong>
      </aside>
      <section className="employee-dialog-avatar-section" aria-label={t("employee.avatarTitle")}>
        <div className="employee-dialog-section-heading">
          <div>
            <strong>{t("employee.avatarTitle")}</strong>
          </div>
        </div>
        <div className="employee-dialog-avatar-tabs" role="tablist" aria-label={t("employee.avatarModeLabel")}>
          <AnimatedBackground value={draft.mode} backgroundClassName="employee-dialog-avatar-tab-thumb">
            {(
              [
                ["generated", t("employee.avatarGenerated")],
                ["initials", t("employee.avatarInitials")],
                ["upload", t("employee.avatarUpload")],
              ] as Array<[RoomMemberAvatarMode, string]>
            ).map(([mode, label]) => (
              <button
                id={`${tabsId}-${mode}-tab`}
                key={mode}
                type="button"
                role="tab"
                aria-controls={`${tabsId}-${mode}-panel`}
                aria-selected={draft.mode === mode}
                tabIndex={draft.mode === mode ? 0 : -1}
                data-active={draft.mode === mode ? "true" : "false"}
                data-id={mode}
                disabled={props.disabled || saving}
                onKeyDown={handleTabListKeyDown}
                onClick={() => setMode(mode)}
              >
                {label}
              </button>
            ))}
          </AnimatedBackground>
        </div>
        {draft.mode === "generated" ? (
          <div
            className="employee-dialog-avatar-panel employee-dialog-avatar-generated-panel"
            id={`${tabsId}-generated-panel`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-generated-tab`}
          >
            <div className="employee-dialog-avatar-panel-toolbar">
              <button
                className="employee-dialog-avatar-refresh-button"
                type="button"
                disabled={props.disabled || saving}
                onClick={() => {
                  const nextBatch = avatarBatch + 1;
                  setAvatarBatch(nextBatch);
                  setDraft((current) => ({
                    ...current,
                    mode: "generated",
                    seed: `${props.member.id}:notionists:${nextBatch}:0`,
                    dataUrl: "",
                  }));
                }}
              >
                <ProductIcon name="refresh" size={16} />
                {t("employee.avatarRefresh")}
              </button>
            </div>
            <div className="employee-dialog-avatar-grid" role="radiogroup" aria-label={t("employee.avatarGenerated")}>
              {avatarSeeds.map((seed, index) => {
                const activeSeed = draft.seed || defaultSeed;
                return (
                  <button
                    key={seed}
                    className="employee-dialog-avatar-option"
                    type="button"
                    role="radio"
                    aria-checked={seed === activeSeed}
                    tabIndex={seed === activeSeed || (index === 0 && !avatarSeeds.includes(activeSeed)) ? 0 : -1}
                    data-active={seed === activeSeed ? "true" : "false"}
                    disabled={props.disabled || saving}
                    onKeyDown={handleRadioGroupKeyDown}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        mode: "generated",
                        seed,
                        dataUrl: "",
                      }))
                    }
                    aria-label={t("employee.avatarChooseGeneratedIndex", { index: index + 1 })}
                  >
                    <EmployeeAvatar seed={seed} fallbackName={props.member.name} size={44} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : draft.mode === "initials" ? (
          <div
            className="employee-dialog-avatar-panel"
            id={`${tabsId}-initials-panel`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-initials-tab`}
          >
            <div className="employee-dialog-avatar-mode-card">
              <span className="employee-dialog-avatar-mode-preview">
                <NameAvatarFallback
                  name={props.member.name || t("employee.newEmployeeInitial")}
                  value={props.member.name || props.member.id}
                  size={48}
                />
              </span>
              <div>
                <strong>{t("employee.avatarInitialsPreview")}</strong>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="employee-dialog-avatar-panel"
            id={`${tabsId}-upload-panel`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-upload-tab`}
          >
            <div className="employee-dialog-avatar-mode-card">
              <span className="employee-dialog-avatar-mode-preview">
                <RoomMemberAvatar member={previewMember} showStatus={false} />
              </span>
              <div>
                <strong>{draft.dataUrl ? t("employee.avatarUploadReady") : t("employee.avatarUploadPrompt")}</strong>
              </div>
              <button
                className="employee-dialog-upload-button"
                type="button"
                disabled={props.disabled || saving}
                onClick={() => uploadInputRef.current?.click()}
              >
                <ProductIcon name="upload" size={16} />
                {draft.dataUrl ? t("employee.avatarReplace") : t("employee.avatarChooseFile")}
              </button>
              <input
                ref={uploadInputRef}
                className="employee-dialog-avatar-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleUpload}
              />
            </div>
          </div>
        )}
        {error ? (
          <p className="employee-dialog-avatar-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
  const confirmAction = (
    <button
      className="primary-button"
      type="button"
      disabled={props.disabled || saving || !avatarDraftIsValid(draft)}
      onClick={() => void confirm()}
    >
      {saving ? t("common.saving") : t("common.confirm")}
    </button>
  );

  if (insideDialog) {
    return props.open ? (
      <DialogSubpage
        className="employee-avatar-picker-subpage"
        title={t("employee.avatarTitle")}
        backLabel={t("common.back")}
        actions={confirmAction}
        onBack={() => props.onOpenChange(false)}
      >
        {pickerLayout}
      </DialogSubpage>
    ) : null;
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="employee-avatar-picker-dialog" aria-label={t("employee.avatarTitle")}>
        <header className="employee-avatar-picker-dialog-header">
          <DialogTitle>{t("employee.avatarTitle")}</DialogTitle>
          <button type="button" aria-label={t("mountedApp.close")} onClick={() => props.onOpenChange(false)}>
            <ProductIcon name="close" size={18} />
          </button>
        </header>
        {pickerLayout}
        <div className="modal-actions">{confirmAction}</div>
      </DialogContent>
    </Dialog>
  );
}

function avatarDraftFromMember(member: RoomMember): EmployeeAvatarDraft {
  return {
    mode: member.avatarMode ?? (member.avatarDataUrl ? "upload" : "generated"),
    seed: member.avatarSeed ?? "",
    dataUrl: member.avatarDataUrl ?? "",
  };
}

function employeeAvatarPreviewMember(member: RoomMember, draft: EmployeeAvatarDraft): RoomMember {
  return {
    ...member,
    avatarMode: draft.mode,
    avatarSeed: draft.mode === "generated" ? draft.seed || undefined : undefined,
    avatarDataUrl: draft.mode === "upload" ? draft.dataUrl || undefined : undefined,
  };
}

function avatarDraftIsValid(draft: EmployeeAvatarDraft): boolean {
  return draft.mode !== "upload" || isSupportedRoomMemberAvatarDataUrl(draft.dataUrl);
}

function avatarErrorForMember(member: RoomMember, t: ReturnType<typeof useI18n>["t"]): string {
  return member.avatarMode === "upload" && !isSupportedRoomMemberAvatarDataUrl(member.avatarDataUrl)
    ? t("employee.avatarLegacyInvalid")
    : "";
}

function employeeAvatarSignature(member: RoomMember): string {
  return JSON.stringify({
    id: member.id,
    name: member.name,
    employeeDefinitionId: member.employeeDefinitionId,
    appId: member.appId,
    storePackageId: member.storePackageId,
    avatarMode: member.avatarMode,
    avatarSeed: member.avatarSeed,
    avatarDataUrl: member.avatarDataUrl,
  });
}

function avatarSeedOptions(id: string, batch: number, selectedSeed: string): string[] {
  const seeds = Array.from({ length: 8 }, (_, index) => `${id}:notionists:${batch}:${index}`);
  if (selectedSeed && !seeds.includes(selectedSeed)) seeds[0] = selectedSeed;
  return seeds;
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

function handleTabListKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const tablist = event.currentTarget.closest('[role="tablist"]');
  if (!tablist) return;
  const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('button[role="tab"]:not(:disabled)'));
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length < 2) return;
  event.preventDefault();
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  const next = tabs[nextIndex];
  next?.focus();
  next?.click();
}
