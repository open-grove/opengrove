import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExtensionItemRecord, MountedAppIdentity } from "../../bridge";
import { getMountedAppIdentity, updateMountedAppIdentity } from "../../bridge";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { AppIdentityEditor, type AppIdentityDraft } from "./app-identity-editor";
import styles from "./app-settings-dialog.module.css";

export function AppSettingsDialog(props: {
  app: ExtensionItemRecord | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const appId = props.app?.name || props.app?.id || "";
  const [draft, setDraft] = useState<AppIdentityDraft>(() => identityFromInventory(props.app));
  const initializedAppIdRef = useRef("");
  const identityQuery = useQuery({
    queryKey: ["mounted-app-identity", appId],
    queryFn: async () => {
      const result = await getMountedAppIdentity(appId);
      if (!result.ok || !result.app) throw new Error(result.error || "app_identity_load_failed");
      return result.app;
    },
    enabled: props.open && Boolean(appId),
    staleTime: 0,
  });

  useEffect(() => {
    if (!props.open) {
      initializedAppIdRef.current = "";
      return;
    }
    if (!appId || initializedAppIdRef.current === appId || (identityQuery.isPending && !identityQuery.data)) {
      return;
    }
    const remoteIdentity = identityQuery.data?.id === appId ? identityQuery.data : undefined;
    setDraft(remoteIdentity ?? identityFromInventory(props.app));
    initializedAppIdRef.current = appId;
  }, [appId, identityQuery.data, identityQuery.isPending, props.app, props.open]);

  const saveMutation = useMutation({
    mutationFn: async (value: AppIdentityDraft) => {
      const baseline = identityQuery.data;
      const payload: { title: string; description: string; icon?: string } = {
        title: value.title.trim(),
        description: value.description.trim(),
      };
      if (value.icon !== baseline?.icon) payload.icon = value.icon;
      const result = await updateMountedAppIdentity(appId, payload);
      if (!result.ok || !result.app) throw new Error(result.error || "app_identity_save_failed");
      return result.app;
    },
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
      void queryClient.invalidateQueries({ queryKey: ["extensions"] });
      props.onOpenChange(false);
    },
  });

  const loading = identityQuery.isPending && !identityQuery.data;
  const error = identityQuery.error || saveMutation.error;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className={styles.dialog} aria-label={t("appSettings.title")}>
        <DialogTitle>{t("appSettings.title")}</DialogTitle>
        {loading ? (
          <div className={styles.state}>{t("appSettings.loading")}</div>
        ) : (
          <>
            <AppIdentityEditor value={draft} disabled={saveMutation.isPending} onChange={setDraft} />
            {error ? (
              <div className="app-create-error" role="alert">
                {rawDiagnosticText(error instanceof Error ? error.message : String(error))}
              </div>
            ) : null}
            <div className="settings-form-actions">
              <button type="button" disabled={saveMutation.isPending} onClick={() => props.onOpenChange(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="primary"
                type="button"
                disabled={saveMutation.isPending || !draft.title.trim()}
                onClick={() => saveMutation.mutate(draft)}
              >
                {saveMutation.isPending ? t("common.saving") : t("appSettings.save")}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function identityFromInventory(app: ExtensionItemRecord | undefined): MountedAppIdentity {
  const icon = stringValue(app?.metadata?.icon) || stringValue(recordValue(app?.metadata?.ui).icon);
  return {
    id: app?.name || app?.id || "",
    title: app?.title || "",
    description: app?.description || "",
    ...(icon ? { icon } : {}),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
