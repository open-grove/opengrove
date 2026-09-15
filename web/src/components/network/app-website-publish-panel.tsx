import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppWebsiteConfig, AppWebsiteState } from "#protocol";
import { openGroveClient } from "../../opengrove-client";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { bindMountedAppBuilder, postServerRoomMessage } from "../rooms/rooms-api";
import { ObjectSettingsRow, ObjectSettingsSection } from "../ui/object-settings";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import styles from "./app-website-publish-panel.module.css";

export function AppWebsitePublishPanel({ appId }: { appId: string }) {
  const { t } = useI18n();
  const cache = useQueryClient();
  const [reviewSent, setReviewSent] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [actionError, setActionError] = useState("");
  const mutationFeedback = {
    onMutate: () => setActionError(""),
    onError: (error: Error) => setActionError(error.message),
  };
  const [audience, setAudience] = useState("");
  const [roles, setRoles] = useState("");
  const [rollbackDigest, setRollbackDigest] = useState("");
  const selectedAudience: AppWebsiteConfig["audience"] =
    audience === "admin"
      ? { mode: "roles", roles: ["admin"] }
      : audience === "roles"
        ? { mode: "roles", roles: roles.split(/[,，\s]+/).filter(Boolean) }
        : { mode: audience === "public" ? "public" : "authenticated" };
  const queryKey = ["apps", appId, "website"];
  const query = useQuery({
    queryKey,
    queryFn: () => openGroveClient.apps.website.get({ appId }),
    refetchOnWindowFocus: false,
    refetchInterval: reviewSent ? 5000 : false,
  });
  const website = query.data?.website;
  const update = (value: AppWebsiteState) => cache.setQueryData(queryKey, { ok: true, website: value });
  async function sendReview(value: AppWebsiteState) {
    if (!value.reviewTarget) throw new Error(t("website.noBuilder"));
    const { roomId } = value.reviewTarget;
    const binding = await bindMountedAppBuilder(appId, roomId);
    await postServerRoomMessage({
      roomId,
      targetIds: [binding.member.id],
      attachments: [],
      text: t("website.reviewPrompt"),
    });
    setReviewSent(true);
  }
  const prepare = useMutation({
    ...mutationFeedback,
    mutationFn: async () => {
      const result = await openGroveClient.apps.website.prepare({ appId });
      update(result.website);
      const prepared = audience
        ? await openGroveClient.apps.website.configure({ appId, audience: selectedAudience })
        : result;
      update(prepared.website);
      setAudience("");
      if (prepared.website.reviewStatus !== "current") await sendReview(prepared.website);
    },
  });
  const review = useMutation({
    ...mutationFeedback,
    mutationFn: async () => {
      if (website) await sendReview(website);
    },
  });
  const configure = useMutation({
    ...mutationFeedback,
    mutationFn: async () => {
      const result = await openGroveClient.apps.website.configure({ appId, audience: selectedAudience });
      update(result.website);
      setAudience("");
      setReviewSent(false);
    },
  });
  const publish = useMutation({
    ...mutationFeedback,
    mutationFn: async () => {
      if (!website?.artifactSha256) throw new Error(t("website.notReady"));
      const result = await openGroveClient.apps.website.publish({
        appId,
        artifactSha256: website.artifactSha256,
        expectedSha256: website.site?.sha256 ?? "",
      });
      if (website.site && website.site.sha256 !== result.site.sha256) setRollbackDigest(website.site.sha256);
      update({ ...website, site: result.site });
      setConfirmPublish(false);
      setReviewSent(false);
    },
  });
  const rollback = useMutation({
    ...mutationFeedback,
    mutationFn: async () => {
      if (!website?.site || !rollbackDigest) return;
      await openGroveClient.apps.website.activate({
        appId,
        sha256: rollbackDigest,
        expectedSha256: website.site.sha256,
      });
      setRollbackDigest("");
      setConfirmRollback(false);
      await query.refetch();
    },
  });
  const pending =
    prepare.isPending || review.isPending || configure.isPending || publish.isPending || rollback.isPending;
  const error = actionError || query.error;
  const policy = website?.inspection.config?.audience;
  const policySelection =
    audience ||
    (policy?.mode === "roles" && policy.roles.length === 1 && policy.roles[0] === "admin"
      ? "admin"
      : (policy?.mode ?? "authenticated"));
  const reviewCurrent = website?.reviewStatus === "current";
  const ready = reviewCurrent && !website.remoteError && !audience;
  return (
    <>
      <div className={styles.body}>
        <p>{t("website.description")}</p>
        {query.isPending ? <p role="status">{t("website.loading")}</p> : null}
        {error ? (
          <p role="alert">
            {t("website.failed")} {rawDiagnosticText(error instanceof Error ? error.message : String(error))}
          </p>
        ) : null}
        {website ? (
          <>
            <ObjectSettingsSection>
              <ObjectSettingsRow
                title={t("website.state")}
                detail={
                  reviewCurrent
                    ? t("website.ready")
                    : website.reviewStatus === "stale"
                      ? t("website.stale")
                      : website.inspection.ready
                        ? t("website.needsReview")
                        : t("website.needsAdaptation")
                }
              />
              {website.site ? (
                <ObjectSettingsRow
                  title={t("website.address")}
                  detail={
                    <a href={website.site.url} target="_blank" rel="noreferrer">
                      {website.site.url}
                    </a>
                  }
                />
              ) : null}
            </ObjectSettingsSection>
            <label className={styles.policy}>
              {t("website.audience")}
              <select
                disabled={pending}
                value={policySelection}
                onChange={(event) => {
                  setAudience(event.target.value);
                  setRoles(policy?.mode === "roles" ? policy.roles.join(", ") : "");
                }}
              >
                <option value="public">{t("website.public")}</option>
                <option value="authenticated">{t("website.authenticated")}</option>
                <option value="admin">{t("website.admin")}</option>
                <option value="roles">{t("website.roles")}</option>
              </select>
            </label>
            {policySelection === "roles" ? (
              <label className={styles.policy}>
                {t("website.roleNames")}
                <input
                  disabled={pending}
                  value={audience ? roles : policy?.mode === "roles" ? policy.roles.join(", ") : ""}
                  onChange={(event) => {
                    setAudience("roles");
                    setRoles(event.target.value);
                  }}
                />
                <small>{t("website.rolesHelp")}</small>
              </label>
            ) : null}
            {audience && website.inspection.config ? (
              <button className="og-button" disabled={pending} onClick={() => configure.mutate()}>
                {t("website.saveAudience")}
              </button>
            ) : null}
            {website.inspection.config ? (
              <>
                <p>
                  {t("website.included")} {website.inspection.config.includedFeatures.join(" · ")}
                </p>
                {website.inspection.config.desktopOnlyFeatures.length ? (
                  <p>
                    {t("website.desktopOnly")} {website.inspection.config.desktopOnlyFeatures.join(" · ")}
                  </p>
                ) : null}
              </>
            ) : null}
            {website.remoteError ? (
              <p role="status">
                {t("website.hostingUnavailable")} {rawDiagnosticText(website.remoteError)}
              </p>
            ) : null}
            {reviewSent && !reviewCurrent ? <p role="status">{t("website.reviewSent")}</p> : null}
            {website.review ? <p>{website.review.summary}</p> : null}
            <div className={styles.actions}>
              {!website.inspection.config ? (
                <button className="og-button" disabled={pending} onClick={() => prepare.mutate()}>
                  {t("website.prepare")}
                </button>
              ) : null}
              {website.inspection.config && !reviewCurrent ? (
                <button
                  className="og-button"
                  disabled={pending || reviewSent || Boolean(audience)}
                  onClick={() => review.mutate()}
                >
                  {t("website.review")}
                </button>
              ) : null}
              <button
                className="og-button"
                disabled={pending || query.isFetching}
                onClick={() => {
                  setReviewSent(false);
                  void query.refetch();
                }}
              >
                {t("website.refresh")}
              </button>
              <button
                className="og-button og-button--primary"
                disabled={pending || !ready}
                onClick={() => setConfirmPublish(true)}
              >
                {t("website.publish")}
              </button>
              {rollbackDigest ? (
                <button className="og-button" disabled={pending} onClick={() => setConfirmRollback(true)}>
                  {t("website.rollback")}
                </button>
              ) : null}
            </div>
            {website.inspection.findings.length ? (
              <details>
                <summary>{t("website.checkDetails")}</summary>
                <ul>
                  {website.inspection.findings.map((finding, index) => (
                    <li key={index}>
                      {rawDiagnosticText(finding.code)}
                      {finding.path ? " · " + finding.path : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}
      </div>
      <Dialog
        open={confirmPublish}
        onOpenChange={(value) => {
          if (!publish.isPending) setConfirmPublish(value);
        }}
      >
        <DialogContent>
          <DialogTitle>{t("website.publish")}</DialogTitle>
          <p>{t("website.publishConfirmation")}</p>
          {actionError ? (
            <p role="alert">
              {t("website.failed")} {rawDiagnosticText(actionError)}
            </p>
          ) : null}
          <p>
            {policySelection === "public"
              ? t("website.public")
              : policySelection === "authenticated"
                ? t("website.authenticated")
                : policySelection === "admin"
                  ? t("website.admin")
                  : policy?.mode === "roles"
                    ? policy.roles.join(", ")
                    : ""}
          </p>
          <div className={styles.actions}>
            <button className="og-button" disabled={publish.isPending} onClick={() => setConfirmPublish(false)}>
              {t("common.cancel")}
            </button>
            <button
              className="og-button og-button--primary"
              disabled={publish.isPending || !ready}
              onClick={() => publish.mutate()}
            >
              {t("website.publish")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmRollback}
        onOpenChange={(value) => {
          if (!rollback.isPending) setConfirmRollback(value);
        }}
      >
        <DialogContent>
          <DialogTitle>{t("website.rollback")}</DialogTitle>
          <p>{t("website.rollbackConfirmation")}</p>
          {actionError ? (
            <p role="alert">
              {t("website.failed")} {rawDiagnosticText(actionError)}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button className="og-button" disabled={rollback.isPending} onClick={() => setConfirmRollback(false)}>
              {t("common.cancel")}
            </button>
            <button className="og-button" disabled={rollback.isPending} onClick={() => rollback.mutate()}>
              {t("website.rollback")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
