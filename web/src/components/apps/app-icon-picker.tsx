import { useEffect, useMemo, useRef, useState } from "react";
import {
  APP_SYSTEM_ICON_NAMES,
  appSystemIconToken,
  parseAppSystemIconToken,
  type AppSystemIconName,
} from "../../../../src/app-icons/catalog";
import { useI18n, type TranslationKey } from "../../i18n";
import { Dialog, DialogContent, DialogSubpage, DialogTitle, useInsideDialogContent } from "../ui/dialog";
import { AppIdentityIcon, AppIdentityIconTile } from "../ui/grove-app-icon";
import { IdentityImageTrigger } from "../ui/identity-image-trigger";
import { ProductIcon } from "../ui/product-icon";
import { appIconUploadErrorCode, prepareAppIconUpload } from "./app-icon-upload";
import "./app-create-wizard.css";

export const DEFAULT_APP_SYSTEM_ICON = appSystemIconToken("app-window");

const SYSTEM_ICON_LABEL_KEYS = {
  "app-window": "appIcon.appWindow",
  article: "appIcon.article",
  books: "appIcon.books",
  briefcase: "appIcon.briefcase",
  camera: "appIcon.camera",
  "chart-bar": "appIcon.chartBar",
  code: "appIcon.code",
  database: "appIcon.database",
  "film-slate": "appIcon.filmSlate",
  "flower-lotus": "appIcon.flowerLotus",
  globe: "appIcon.globe",
  lightbulb: "appIcon.lightbulb",
  megaphone: "appIcon.megaphone",
  palette: "appIcon.palette",
  rocket: "appIcon.rocket",
  robot: "appIcon.robot",
  "shopping-bag": "appIcon.shoppingBag",
  users: "appIcon.users",
  wrench: "appIcon.wrench",
} satisfies Record<AppSystemIconName, TranslationKey>;

export function AppIconPickerField(props: {
  value?: string;
  title: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const insideDialog = useInsideDialogContent();
  const pickerLayout = (
    <div className="app-icon-picker-dialog-layout">
      <aside className="app-icon-picker-dialog-preview">
        <span>{t("appIcon.preview")}</span>
        <AppIdentityIconTile icon={props.value} input={{ title: props.title }} iconSize={72} aria-hidden="true" />
        <strong>{props.title}</strong>
      </aside>
      <AppIconPicker value={props.value} disabled={props.disabled} onChange={props.onChange} />
    </div>
  );
  const confirmAction = (
    <button className="primary-button" type="button" onClick={() => setOpen(false)}>
      {t("common.confirm")}
    </button>
  );

  return (
    <>
      <IdentityImageTrigger
        label={t("appIcon.change")}
        title={props.title}
        shape="rounded"
        disabled={props.disabled}
        onClick={() => setOpen(true)}
      >
        <AppIdentityIconTile icon={props.value} input={{ title: props.title }} iconSize={52} aria-hidden="true" />
      </IdentityImageTrigger>
      {insideDialog && open ? (
        <DialogSubpage
          className="app-icon-picker-subpage"
          title={t("appIcon.title")}
          backLabel={t("common.back")}
          actions={confirmAction}
          onBack={() => setOpen(false)}
        >
          {pickerLayout}
        </DialogSubpage>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="app-icon-picker-dialog" aria-label={t("appIcon.title")}>
            <header className="app-icon-picker-dialog-header">
              <DialogTitle>{t("appIcon.title")}</DialogTitle>
              <button type="button" aria-label={t("mountedApp.close")} onClick={() => setOpen(false)}>
                <ProductIcon name="close" size={18} />
              </button>
            </header>
            {pickerLayout}
            <div className="modal-actions">{confirmAction}</div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export function AppIconPicker(props: { value?: string; disabled?: boolean; onChange(value: string): void }) {
  const { t } = useI18n();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const customIcon = isCustomIcon(props.value) ? props.value : "";
  const [mode, setMode] = useState<"system" | "upload">(customIcon ? "upload" : "system");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const filteredIcons = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return APP_SYSTEM_ICON_NAMES.filter(
      (name) => !query || name.includes(query) || t(SYSTEM_ICON_LABEL_KEYS[name]).toLocaleLowerCase().includes(query),
    );
  }, [search, t]);

  useEffect(() => {
    if (isCustomIcon(props.value)) setMode("upload");
    else if (parseAppSystemIconToken(props.value)) setMode("system");
  }, [props.value]);

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      props.onChange(await prepareAppIconUpload(file));
      setMode("upload");
    } catch (uploadError) {
      setError(t(errorTranslationKey(appIconUploadErrorCode(uploadError))));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  return (
    <div className="app-create-icon-panel">
      <div className="app-create-icon-tabs" role="tablist" aria-label={t("appIcon.title")}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "system"}
          disabled={props.disabled}
          onClick={() => {
            setMode("system");
            setError("");
          }}
        >
          {t("appIcon.system")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "upload"}
          disabled={props.disabled}
          onClick={() => {
            setMode("upload");
            setError("");
          }}
        >
          {t("appIcon.upload")}
        </button>
      </div>

      {mode === "system" ? (
        <div className="app-create-icon-library" role="tabpanel">
          <label className="app-create-icon-search">
            <ProductIcon name="search" size={17} aria-hidden="true" />
            <input
              value={search}
              disabled={props.disabled}
              placeholder={t("appIcon.searchPlaceholder")}
              aria-label={t("appIcon.searchPlaceholder")}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="app-create-icon-grid">
            {filteredIcons.map((name) => {
              const icon = appSystemIconToken(name);
              const label = t(SYSTEM_ICON_LABEL_KEYS[name]);
              return (
                <button
                  key={name}
                  type="button"
                  className={props.value === icon ? "is-selected" : ""}
                  disabled={props.disabled}
                  aria-pressed={props.value === icon}
                  aria-label={t("appIcon.optionAria", { name: label })}
                  title={label}
                  onClick={() => props.onChange(icon)}
                >
                  <AppIdentityIcon icon={icon} size={24} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
          {!filteredIcons.length ? <p className="app-create-icon-empty">{t("appIcon.noResults")}</p> : null}
        </div>
      ) : (
        <div className="app-create-icon-upload" role="tabpanel">
          <input
            ref={uploadInputRef}
            type="file"
            hidden
            accept=".png,.webp,.svg,image/png,image/webp,image/svg+xml"
            onChange={(event) => void handleUpload(event.target.files?.[0])}
          />
          {customIcon ? (
            <AppIdentityIconTile icon={customIcon} iconSize={48} aria-hidden="true" />
          ) : (
            <span className="app-create-icon-upload-placeholder">
              <ProductIcon name="upload" size={26} aria-hidden="true" />
            </span>
          )}
          <div>
            <strong>{customIcon ? t("appIcon.customReady") : t("appIcon.uploadTitle")}</strong>
            <small>{t("appIcon.uploadHint")}</small>
          </div>
          <button type="button" disabled={props.disabled || uploading} onClick={() => uploadInputRef.current?.click()}>
            {uploading ? t("appIcon.processing") : customIcon ? t("appIcon.replace") : t("appIcon.chooseFile")}
          </button>
        </div>
      )}
      {error ? <p className="app-create-icon-error">{error}</p> : null}
    </div>
  );
}

function errorTranslationKey(code: ReturnType<typeof appIconUploadErrorCode>): TranslationKey {
  if (code === "unsupported_type") return "appIcon.errorUnsupportedType";
  if (code === "too_large") return "appIcon.errorTooLarge";
  if (code === "invalid_svg") return "appIcon.errorInvalidSvg";
  if (code === "output_too_large") return "appIcon.errorOutputTooLarge";
  return "appIcon.errorDecodeFailed";
}

function isCustomIcon(value: string | undefined): value is string {
  return /^data:image\/(?:png|webp);base64,/i.test(value?.trim() ?? "");
}
