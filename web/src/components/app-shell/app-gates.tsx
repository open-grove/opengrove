import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { SUPPORTED_LOCALES, localeDefinition } from "@opengrove/agent-protocol/locale-registry";
import { ArrowRight, Globe2, LoaderCircle, UsersRound, WifiOff } from "lucide-react";
import { authErrorLabel } from "../../app-auth-model";
import { countryOptionsForLocale } from "../../country-codes";
import { rawDiagnosticText, useI18n } from "../../i18n";
import type { TranslationFn } from "../../i18n";
import { teamGateCopy } from "../../locales/team-gate-copy";
import { readDesktopApi } from "../../desktop-api";
import type { DesktopBridgeStartupBlockerAction } from "../../../../src/desktop-bridge-startup-state";
import { OpenGroveSaplingMark } from "../ui/opengrove-sapling-mark";
import { CloudAuthConstellation } from "./cloud-auth-constellation";
import { resolveStartupTimeoutMs } from "./startup-timeout-policy";
import "../rooms/rooms.css";
import "../rooms/rooms-empty-state.css";
import "./app-gates.css";

export function RoomsUnavailableState(props: {
  healthLoading: boolean;
  healthError: string;
  onboardingGuideVisible: boolean;
  onDismissOnboardingGuide(): void;
}) {
  const { t } = useI18n();
  return (
    <section className="rooms-view rooms-unavailable-view rooms-onboarding-view" aria-label={t("app.rooms")}>
      <div
        className="room-empty-state rooms-runtime-empty rooms-runtime-guide"
        data-prominent={props.onboardingGuideVisible ? "true" : "false"}
      >
        <div className="rooms-guide-avatar" aria-hidden="true">
          <OpenGroveSaplingMark />
        </div>
        <UsersRound size={32} />
        <h3>{props.healthLoading ? t("gate.roomsLoadingTitle") : t("gate.roomsUnavailableTitle")}</h3>
        <p>{props.healthError ? t("gate.roomsBridgeDisconnectedCopy") : t("gate.roomsDataPreparingCopy")}</p>
        <div className="rooms-guide-actions">
          <button className="room-primary-button" type="button" onClick={() => window.location.reload()}>
            {t("mountedApp.refresh")}
          </button>
          {props.onboardingGuideVisible ? (
            <button className="rooms-guide-secondary" type="button" onClick={props.onDismissOnboardingGuide}>
              {t("gate.later")}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function CloudAuthScreen(props: {
  sendCodePending: boolean;
  sendCodeRequiresInvite: boolean;
  sendCodeRequiresCountry: boolean;
  sendCodeSuccessCount: number;
  loginPending: boolean;
  toastMessage?: string;
  error: string;
  retryAfter?: number;
  onSendCode(payload: { email: string }): void;
  onLogin(payload: { email: string; code: string; inviteCode?: string; countryCode?: string }): void;
  onContinueWithoutAccount?(): void;
  onResetSendCodeState(): void;
  onResetError(): void;
}) {
  const { language, setLanguagePreference, t } = useI18n();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [inviteRequiredByError, setInviteRequiredByError] = useState(false);
  const [countryRequiredByError, setCountryRequiredByError] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const previousSendCodeSuccessCount = useRef(props.sendCodeSuccessCount);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const inviteCodeInputRef = useRef<HTMLInputElement>(null);
  const countrySelectRef = useRef<HTMLSelectElement>(null);
  const pending = props.loginPending || props.sendCodePending;
  const normalizedEmail = email.trim();
  const normalizedCode = code.trim();
  const normalizedInviteCode = inviteCode.trim();
  const inviteCodeRequired = props.error === "invite_code_required";
  const inviteCodeInvalid = props.error === "invite_code_invalid";
  const inviteCodeFlow = inviteCodeRequired || inviteCodeInvalid;
  const countryCodeInvalid = props.error === "country_code_invalid";
  const countryCodeFlow = props.error === "country_code_required" || countryCodeInvalid;
  const requiresInvite = props.sendCodeRequiresInvite || inviteRequiredByError;
  const showInviteCode = codeSent && requiresInvite;
  const showCountryCode = codeSent && (props.sendCodeRequiresCountry || countryRequiredByError);
  const missingRequiredInviteCode = showInviteCode && !normalizedInviteCode;
  const missingRequiredCountryCode = showCountryCode && !countryCode;
  const registrationFlow = showInviteCode || showCountryCode;
  const countryOptions = useMemo(
    () => (showCountryCode ? countryOptionsForLocale(language) : []),
    [language, showCountryCode],
  );
  const currentLanguageIndex = SUPPORTED_LOCALES.indexOf(language);
  const nextLanguage =
    SUPPORTED_LOCALES[currentLanguageIndex < 0 ? 0 : (currentLanguageIndex + 1) % SUPPORTED_LOCALES.length] ??
    SUPPORTED_LOCALES[0];
  const nextLanguageDefinition = localeDefinition(nextLanguage);
  const nextLanguageShortLabel =
    nextLanguageDefinition.languageCodes[0]?.toUpperCase() ?? nextLanguageDefinition.nativeLabel;
  const desktopPlatform = readDesktopApi()?.platform;

  useEffect(() => {
    if (!props.retryAfter) return;
    setCooldown(Math.max(0, Math.ceil(props.retryAfter)));
  }, [props.retryAfter]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (props.sendCodeSuccessCount > previousSendCodeSuccessCount.current) {
      setCodeSent(true);
      setCooldown(0);
      window.requestAnimationFrame(() => codeInputRef.current?.focus());
    }
    previousSendCodeSuccessCount.current = props.sendCodeSuccessCount;
  }, [props.sendCodeSuccessCount]);

  useEffect(() => {
    if (inviteCodeFlow) {
      setInviteRequiredByError(true);
      window.requestAnimationFrame(() => inviteCodeInputRef.current?.focus());
    }
    if (countryCodeFlow) {
      setCountryRequiredByError(true);
      window.requestAnimationFrame(() => countrySelectRef.current?.focus());
    }
  }, [props.error]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedEmail || pending) return;
    if (!codeSent) {
      if (cooldown > 0) return;
      props.onResetError();
      props.onSendCode({ email: normalizedEmail });
      return;
    }
    if (!/^\d{6}$/.test(normalizedCode)) return;
    if (missingRequiredInviteCode) return;
    if (missingRequiredCountryCode) return;
    props.onResetError();
    props.onLogin({
      email: normalizedEmail,
      code: normalizedCode,
      ...(showInviteCode && normalizedInviteCode ? { inviteCode: normalizedInviteCode } : {}),
      ...(showCountryCode && countryCode ? { countryCode } : {}),
    });
  }

  function resendCode() {
    if (!normalizedEmail || pending || cooldown > 0) return;
    props.onResetError();
    props.onSendCode({ email: normalizedEmail });
  }

  function updateEmail(event: ChangeEvent<HTMLInputElement>) {
    setEmail(event.currentTarget.value);
    setCode("");
    setInviteCode("");
    setCountryCode("");
    setCodeSent(false);
    setInviteRequiredByError(false);
    setCountryRequiredByError(false);
    props.onResetSendCodeState();
    props.onResetError();
  }

  function editEmail() {
    if (pending) return;
    setCode("");
    setInviteCode("");
    setCountryCode("");
    setCodeSent(false);
    setInviteRequiredByError(false);
    setCountryRequiredByError(false);
    props.onResetSendCodeState();
    props.onResetError();
    window.requestAnimationFrame(() => emailInputRef.current?.focus());
  }

  function updateCode(event: ChangeEvent<HTMLInputElement>) {
    setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6));
    props.onResetError();
  }

  function updateInviteCode(event: ChangeEvent<HTMLInputElement>) {
    setInviteCode(event.currentTarget.value.toUpperCase());
    props.onResetError();
  }

  function updateCountryCode(event: ChangeEvent<HTMLSelectElement>) {
    setCountryCode(event.currentTarget.value);
    props.onResetError();
  }

  return (
    <main
      className="cloud-auth-shell"
      data-step={registrationFlow ? "registration" : codeSent ? "code" : "email"}
      data-desktop-platform={desktopPlatform || undefined}
    >
      <div className="cloud-auth-window-drag-region" aria-hidden="true" />
      <CloudAuthConstellation />

      <div className="cloud-auth-page-brand" aria-label="OpenGrove">
        <span className="cloud-auth-logo" aria-hidden="true">
          <OpenGroveSaplingMark />
        </span>
        <span className="cloud-auth-wordmark">
          Open<span>Grove</span>
        </span>
      </div>

      <button
        className="cloud-auth-language"
        type="button"
        aria-label={t("auth.switchLanguage", { language: nextLanguageDefinition.nativeLabel })}
        onClick={() => setLanguagePreference(nextLanguage)}
      >
        <Globe2 size={15} aria-hidden="true" />
        <span>{nextLanguageShortLabel}</span>
      </button>

      <div className="cloud-auth-stack">
        {props.toastMessage ? (
          <div className="cloud-auth-toast" role="status">
            {props.toastMessage}
          </div>
        ) : null}
        <form className="cloud-auth-panel" onSubmit={submit} aria-label={t("auth.loginAria")}>
          <header className="cloud-auth-header">
            <div className="cloud-auth-heading">
              <h1>
                <span>{t("auth.returnToYour")}</span>
                <em>Grove</em>
              </h1>
            </div>
          </header>

          {!codeSent ? (
            <label className="bridge-token-field">
              <span className="cloud-auth-field-label">{t("auth.emailLabel")}</span>
              <span className="cloud-auth-input-wrap">
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  autoFocus
                  autoComplete="email"
                  placeholder={t("auth.emailPlaceholder")}
                  disabled={pending}
                  onChange={updateEmail}
                />
              </span>
            </label>
          ) : (
            <>
              <div className="cloud-auth-email-summary">
                <strong>{normalizedEmail}</strong>
                <button type="button" disabled={pending} onClick={editEmail}>
                  {t("auth.changeEmail")}
                </button>
              </div>

              <label className="bridge-token-field">
                <span className="cloud-auth-field-label">{t("auth.codeLabel")}</span>
                <span
                  className="cloud-auth-code-input"
                  data-invalid={props.error === "verification_code_invalid" ? "true" : undefined}
                >
                  <input
                    ref={codeInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={code}
                    disabled={pending}
                    autoComplete="one-time-code"
                    maxLength={6}
                    aria-label={t("auth.codeLabel")}
                    aria-invalid={props.error === "verification_code_invalid" || undefined}
                    onChange={updateCode}
                  />
                  <span className="cloud-auth-code-boxes" aria-hidden="true">
                    {Array.from({ length: 6 }, (_, index) => (
                      <span
                        key={index}
                        data-active={index === Math.min(code.length, 5) ? "true" : undefined}
                        data-filled={code[index] ? "true" : undefined}
                      >
                        {code[index] ?? ""}
                      </span>
                    ))}
                  </span>
                </span>
              </label>
            </>
          )}

          {showCountryCode ? (
            <label className="bridge-token-field">
              <span className="cloud-auth-field-label">{t("auth.countryLabel")}</span>
              <span className="cloud-auth-input-wrap" data-invalid={countryCodeInvalid ? "true" : undefined}>
                <select
                  ref={countrySelectRef}
                  className="cloud-auth-country-select"
                  value={countryCode}
                  disabled={pending}
                  required
                  autoComplete="country"
                  aria-required="true"
                  aria-invalid={countryCodeInvalid || undefined}
                  onChange={updateCountryCode}
                >
                  <option value="" disabled hidden>
                    {t("auth.countryPlaceholder")}
                  </option>
                  {countryOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label} ({option.code})
                    </option>
                  ))}
                </select>
              </span>
              <span className="cloud-auth-field-hint">{t("auth.countryHint")}</span>
            </label>
          ) : null}

          {showInviteCode ? (
            <label className="bridge-token-field">
              <span className="cloud-auth-field-label">{t("auth.inviteCodeLabel")}</span>
              <span className="cloud-auth-input-wrap" data-invalid={inviteCodeInvalid ? "true" : undefined}>
                <input
                  ref={inviteCodeInputRef}
                  type="text"
                  value={inviteCode}
                  disabled={pending}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={32}
                  placeholder={t("auth.inviteCodePlaceholder")}
                  required={showInviteCode}
                  aria-required={showInviteCode}
                  aria-invalid={inviteCodeInvalid || undefined}
                  onChange={updateInviteCode}
                />
              </span>
              <span className="cloud-auth-field-hint">{t("auth.inviteCodeHint")}</span>
            </label>
          ) : null}

          <div className="cloud-auth-feedback" aria-live="polite">
            {props.error ? (
              <p
                className={inviteCodeRequired ? "cloud-auth-status" : "bridge-token-error"}
                role={inviteCodeRequired ? "status" : "alert"}
              >
                {authErrorLabel(props.error)}
              </p>
            ) : null}
            {codeSent ? (
              <button
                className="cloud-auth-resend"
                type="button"
                disabled={pending || cooldown > 0 || !normalizedEmail}
                onClick={resendCode}
              >
                {cooldown > 0 ? cooldownLabel(cooldown, "resend", t) : t("auth.resendCode")}
              </button>
            ) : null}
          </div>

          <div className="cloud-auth-actions">
            <button
              className="bridge-token-submit"
              type="submit"
              disabled={
                pending ||
                !normalizedEmail ||
                (!codeSent && cooldown > 0) ||
                (codeSent && !/^\d{6}$/.test(normalizedCode)) ||
                missingRequiredInviteCode ||
                missingRequiredCountryCode
              }
            >
              <span>
                {pending
                  ? t("auth.pleaseWait")
                  : !codeSent && cooldown > 0
                    ? cooldownLabel(cooldown, "send", t)
                    : codeSent
                      ? registrationFlow
                        ? t("auth.finishRegistration")
                        : t("auth.enterOpenGrove")
                      : t("auth.getCode")}
              </span>
              <ArrowRight size={15} aria-hidden="true" />
            </button>
            {!codeSent && props.onContinueWithoutAccount ? (
              <button
                className="cloud-auth-continue-local"
                type="button"
                disabled={pending}
                onClick={props.onContinueWithoutAccount}
              >
                {t("auth.continueWithoutAccount")}
              </button>
            ) : null}
          </div>

          {!codeSent ? <p className="cloud-auth-legal">{t("auth.legalNotice")}</p> : null}
        </form>
      </div>
    </main>
  );
}

/**
 * Collects the shared team token a test ww deployment requires before sign-in.
 *
 * Shown only when the bridge reports that its ww deployment has such a gate and
 * that the token it holds does not satisfy it, so a production deployment never
 * renders this at all. The token is submitted once and kept by the bridge; this
 * screen deliberately keeps no copy of it and offers no "remember me".
 */
export function TeamGateScreen(props: {
  pending: boolean;
  invalid: boolean;
  unavailable: boolean;
  onSubmit(token: string): void;
  onResetError(): void;
}) {
  const { language } = useI18n();
  const copy = teamGateCopy(language);
  const [token, setToken] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedToken = token.trim();
  const desktopPlatform = readDesktopApi()?.platform;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (props.pending || !normalizedToken) return;
    props.onResetError();
    props.onSubmit(normalizedToken);
  }

  return (
    <main className="cloud-auth-shell" data-step="team-gate" data-desktop-platform={desktopPlatform || undefined}>
      <div className="cloud-auth-window-drag-region" aria-hidden="true" />
      <CloudAuthConstellation />

      <div className="cloud-auth-page-brand" aria-label="OpenGrove">
        <span className="cloud-auth-logo" aria-hidden="true">
          <OpenGroveSaplingMark />
        </span>
        <span className="cloud-auth-wordmark">
          Open<span>Grove</span>
        </span>
      </div>

      <div className="cloud-auth-stack">
        <form className="cloud-auth-panel" onSubmit={submit} aria-label={copy.title}>
          <header className="cloud-auth-header">
            <div className="cloud-auth-heading">
              <h1>
                <span>{copy.title}</span>
              </h1>
            </div>
          </header>

          <p className="cloud-auth-status">{copy.hint}</p>

          <label className="bridge-token-field">
            <span className="cloud-auth-field-label">{copy.tokenLabel}</span>
            <span className="cloud-auth-input-wrap">
              <input
                ref={inputRef}
                // A shared secret, not a personal one: never offer to remember it,
                // and keep it out of the browser's saved-password store.
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                autoFocus
                placeholder={copy.tokenPlaceholder}
                disabled={props.pending}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setToken(event.currentTarget.value);
                  props.onResetError();
                }}
              />
            </span>
          </label>

          <div className="cloud-auth-feedback" aria-live="polite">
            {props.invalid ? (
              <p className="bridge-token-error" role="alert">
                {copy.invalid}
              </p>
            ) : props.unavailable ? (
              <p className="bridge-token-error" role="alert">
                {copy.unavailable}
              </p>
            ) : null}
          </div>

          <div className="cloud-auth-actions">
            <button className="bridge-token-submit" type="submit" disabled={props.pending || !normalizedToken}>
              <span>{props.pending ? copy.pending : copy.submit}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>

          <p className="cloud-auth-legal">{copy.privacy}</p>
        </form>
      </div>
    </main>
  );
}

/**
 * Offers the test accounts directly, as the first thing past the team gate.
 *
 * On a gated deployment this is the path people actually want: proving team
 * membership already happened, so asking for an email and a verification code
 * on top of it is friction with nothing behind it. Email sign-in stays reachable
 * for the cases that need it -- your own account, or exercising the real
 * verification chain.
 */
export function TeamAccountPickerScreen(props: {
  accounts: readonly { email: string; roles: string[]; status: string }[];
  loading: boolean;
  switchingEmail?: string;
  error: string;
  onPick(email: string): void;
  onUseEmail(): void;
}) {
  const { language } = useI18n();
  const copy = teamGateCopy(language);
  const switching = Boolean(props.switchingEmail);
  const desktopPlatform = readDesktopApi()?.platform;

  return (
    <main className="cloud-auth-shell" data-step="team-accounts" data-desktop-platform={desktopPlatform || undefined}>
      <div className="cloud-auth-window-drag-region" aria-hidden="true" />
      <CloudAuthConstellation />

      <div className="cloud-auth-page-brand" aria-label="OpenGrove">
        <span className="cloud-auth-logo" aria-hidden="true">
          <OpenGroveSaplingMark />
        </span>
        <span className="cloud-auth-wordmark">
          Open<span>Grove</span>
        </span>
      </div>

      <div className="cloud-auth-stack">
        <section className="cloud-auth-panel" aria-label={copy.pickTitle}>
          <header className="cloud-auth-header">
            <div className="cloud-auth-heading">
              <h1>
                <span>{copy.pickTitle}</span>
              </h1>
            </div>
          </header>

          <p className="cloud-auth-status">{copy.pickHint}</p>

          <div className="cloud-auth-feedback" aria-live="polite">
            {props.error ? (
              <p className="bridge-token-error" role="alert">
                {props.error}
              </p>
            ) : null}
          </div>

          {props.loading ? (
            <p className="cloud-auth-status">
              <LoaderCircle size={14} aria-hidden="true" /> {copy.pending}
            </p>
          ) : props.accounts.length === 0 ? (
            <p className="cloud-auth-status">{copy.pickEmpty}</p>
          ) : (
            <div className="team-account-picker-list" role="list">
              {props.accounts.map((account) => (
                <button
                  key={account.email}
                  className="team-account-picker-option"
                  type="button"
                  role="listitem"
                  // A disabled account exists but cannot sign in, so it is shown
                  // (the database is the truth) and not offered.
                  disabled={switching || account.status !== "active"}
                  data-pending={props.switchingEmail === account.email ? "true" : undefined}
                  onClick={() => props.onPick(account.email)}
                >
                  <span className="team-account-picker-identity">
                    <strong>{account.email.replace("@example.test", "")}</strong>
                    <small>
                      {account.status !== "active" ? `${account.status} · ` : ""}
                      {account.roles.length > 0 ? account.roles.join(" + ") : copy.pickNoRoles}
                    </small>
                  </span>
                  {props.switchingEmail === account.email ? (
                    <LoaderCircle size={15} aria-hidden="true" />
                  ) : (
                    <ArrowRight size={15} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="cloud-auth-actions">
            <button className="cloud-auth-continue-local" type="button" disabled={switching} onClick={props.onUseEmail}>
              {copy.useEmail}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function cooldownLabel(seconds: number, variant: "resend" | "send", t: TranslationFn): string {
  const value = Math.max(0, Math.ceil(seconds));
  if (value >= 90) {
    const minutes = Math.ceil(value / 60);
    return variant === "resend"
      ? t("auth.resendCodeInMinutes", { count: minutes })
      : t("auth.sendCodeInMinutes", { count: minutes });
  }
  return variant === "resend"
    ? t("auth.resendCodeInSeconds", { count: value })
    : t("auth.sendCodeInSeconds", { count: value });
}

export function AccountServiceStatus(props: {
  state?: "checking" | "offline";
  retrying: boolean;
  errorReference?: string;
  onRetry(): void;
}) {
  const { t } = useI18n();
  const offline = props.state === "offline";
  const detail = offline
    ? [
        t("auth.degradedLocalCopy"),
        props.errorReference ? t("auth.errorReference", { reference: props.errorReference }) : "",
      ]
        .filter(Boolean)
        .join("\n")
    : t("auth.accountServiceConnecting");
  return (
    <div className="app-titlebar-account-status-live" role="status" aria-live="polite" aria-atomic="true">
      {props.state ? (
        <div className="app-titlebar-account-status" data-state={props.state} title={detail}>
          {offline ? <WifiOff size={13} aria-hidden="true" /> : <LoaderCircle size={13} aria-hidden="true" />}
          <span>{offline ? t("auth.degradedLocalTitle") : t("auth.accountServiceConnecting")}</span>
          {offline && props.errorReference ? <small>{props.errorReference}</small> : null}
          {offline ? (
            <button
              className="app-titlebar-account-status-retry"
              type="button"
              onClick={props.onRetry}
              disabled={props.retrying}
            >
              {props.retrying ? t("gate.retrying") : t("mountedApp.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function CloudAuthLoadingScreen(props: {
  blocker?: {
    code: string;
    message: string;
    actions: DesktopBridgeStartupBlockerAction[];
  };
  recoveringLocalService?: boolean;
  migratingLocalData?: boolean;
  onRetry(): void;
  timeoutMs?: number;
}) {
  const { t } = useI18n();
  const desktop = readDesktopApi();
  const timeoutMs = resolveStartupTimeoutMs(props);
  const [attempt, setAttempt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedFileName, setExportedFileName] = useState("");
  const [exportedEvidenceComplete, setExportedEvidenceComplete] = useState<boolean | undefined>();
  const [exportError, setExportError] = useState("");
  const [resolvingAction, setResolvingAction] = useState<DesktopBridgeStartupBlockerAction | "">("");
  const [resolutionError, setResolutionError] = useState("");
  const timeoutRecord = useRef<Promise<void> | undefined>(undefined);
  const blocked = Boolean(props.blocker);

  useEffect(() => {
    setTimedOut(false);
    if (blocked) return undefined;
    const timer = window.setTimeout(() => {
      setTimedOut(true);
      if (desktop) {
        console.error("[opengrove-ui] desktop startup timeout", { code: "desktop_startup_timeout" });
        timeoutRecord.current = desktop
          .recordStartupTimeout?.()
          .then(() => undefined)
          .catch((error) => {
            console.error("[opengrove-ui] desktop startup timeout record failed", error);
          });
      }
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [attempt, blocked, desktop, timeoutMs]);

  const retry = () => {
    setTimedOut(false);
    setExportedFileName("");
    setExportedEvidenceComplete(undefined);
    setExportError("");
    setResolutionError("");
    timeoutRecord.current = undefined;
    setAttempt((value) => value + 1);
    props.onRetry();
  };

  const resolveBlocker = async (action: DesktopBridgeStartupBlockerAction) => {
    setResolvingAction(action);
    setResolutionError("");
    try {
      if (action === "open_data_dir") {
        await desktop?.openDataDir?.();
      } else {
        await desktop?.resolveBridgeStartupBlocker?.(action);
      }
    } catch (error) {
      setResolutionError(
        t("gate.blockerActionFailed", {
          message: rawDiagnosticText(error instanceof Error ? error.message : String(error)),
        }),
      );
    } finally {
      setResolvingAction("");
    }
  };

  const exportDiagnostics = async () => {
    // Startup may have failed before the Bridge route exists, so this screen
    // deliberately uses the desktop fallback instead of /diagnostics/bundle.
    if (!desktop?.exportDiagnostics) return;
    setExporting(true);
    setExportedFileName("");
    setExportedEvidenceComplete(undefined);
    setExportError("");
    try {
      await timeoutRecord.current;
      const result = await desktop.exportDiagnostics();
      if (result.status === "saved") {
        setExportedFileName(result.fileName);
        setExportedEvidenceComplete(result.evidenceComplete);
      }
    } catch (error) {
      setExportError(
        t("gate.exportDiagnosticsFailed", {
          message: rawDiagnosticText(error instanceof Error ? error.message : String(error)),
        }),
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="cloud-auth-shell cloud-auth-loading-shell" aria-label="OpenGrove">
      <div className="cloud-auth-window-drag-region" aria-hidden="true" />
      {blocked || timedOut ? (
        <section className="cloud-auth-timeout-panel" role="alert">
          <div className="cloud-auth-loading-mark" aria-hidden="true">
            <OpenGroveSaplingMark />
          </div>
          <h1>{t(blocked ? "gate.startupBlockedTitle" : "gate.startupIncompleteTitle")}</h1>
          <p>
            {t(
              blocked
                ? "gate.startupBlockedCopy"
                : props.recoveringLocalService
                  ? "gate.desktopStartupIncompleteCopy"
                  : "gate.startupIncompleteCopy",
            )}
          </p>
          {props.blocker ? <p className="bridge-token-error">{rawDiagnosticText(props.blocker.message)}</p> : null}
          <div className="rooms-guide-actions">
            {props.blocker?.actions.includes("stop_blocking_process") ? (
              <button
                className="og-button og-button--primary cloud-auth-timeout-action"
                type="button"
                onClick={() => void resolveBlocker("stop_blocking_process")}
                disabled={exporting || Boolean(resolvingAction)}
              >
                {t("gate.stopBlockingServiceAndRetry")}
              </button>
            ) : null}
            {props.blocker?.actions.includes("repair_state_access") ? (
              <button
                className="og-button og-button--primary cloud-auth-timeout-action"
                type="button"
                onClick={() => void resolveBlocker("repair_state_access")}
                disabled={exporting || Boolean(resolvingAction)}
              >
                {t("gate.repairStateAccessAndRetry")}
              </button>
            ) : null}
            <button
              className={
                props.blocker
                  ? "og-button cloud-auth-timeout-action"
                  : "og-button cloud-auth-timeout-action cloud-auth-timeout-action--neutral"
              }
              type="button"
              onClick={retry}
              disabled={exporting || Boolean(resolvingAction)}
            >
              {t(props.blocker ? "gate.recheck" : "mountedApp.retry")}
            </button>
            {props.blocker?.actions.includes("open_data_dir") && desktop?.openDataDir ? (
              <button
                className="og-button cloud-auth-timeout-action"
                type="button"
                onClick={() => void resolveBlocker("open_data_dir")}
                disabled={exporting || Boolean(resolvingAction)}
              >
                {t("gate.openDataDirectory")}
              </button>
            ) : null}
            {desktop?.exportDiagnostics ? (
              <button
                className="og-button cloud-auth-timeout-action"
                type="button"
                onClick={exportDiagnostics}
                disabled={exporting}
              >
                {exporting ? t("gate.exporting") : t("gate.exportDiagnostics")}
              </button>
            ) : null}
          </div>
          {exportedFileName ? (
            <p className="cloud-auth-status">{t("gate.exportedFile", { name: exportedFileName })}</p>
          ) : null}
          {exportedEvidenceComplete === false ? (
            <p className="bridge-token-error">{t("gate.exportedFileIncomplete")}</p>
          ) : null}
          {exportError ? <p className="bridge-token-error">{exportError}</p> : null}
          {resolutionError ? <p className="bridge-token-error">{resolutionError}</p> : null}
        </section>
      ) : (
        <CloudAuthStartupProgress migratingLocalData={props.migratingLocalData === true} />
      )}
    </main>
  );
}

function CloudAuthStartupProgress(props: { migratingLocalData: boolean }) {
  const { t } = useI18n();
  const [animationCycle, setAnimationCycle] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const timer = window.setInterval(() => setAnimationCycle((cycle) => cycle + 1), 4_600);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="cloud-auth-loading-progress" role="status" aria-live="polite" aria-atomic="true">
      <div className="cloud-auth-loading-mark" aria-hidden="true" key={animationCycle}>
        <OpenGroveSaplingMark />
      </div>
      <p className="cloud-auth-loading-status">
        {t(props.migratingLocalData ? "gate.migratingLocalData" : "gate.preparingLocalData")}
        <span className="cloud-auth-loading-dots" aria-hidden="true">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </p>
    </div>
  );
}
