import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  BookOpenText,
  Camera,
  ChevronRight,
  Coins,
  CreditCard,
  FileText,
  HelpCircle,
  History,
  LogIn,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Package,
  Plus,
  RefreshCw,
  Settings,
  Sprout,
  Store,
  Trash2,
  UserRound,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import { QRCodeSVG } from "@rc-component/qrcode";
import { useIconStylePreference } from "../../appearance";
import type { ExtensionItemRecord, ViewId } from "../../bridge";
import {
  MOBILE_APPS,
  RAIL_APPS,
  railSectionForView as catalogRailSectionForView,
  type AppIconName,
  type RailSectionId,
} from "../../apps/catalog";
import { compareLocalizedText } from "../../format";
import { countryLabelForLocale } from "../../country-codes";
import { useI18n, type ResolvedLanguage, type TranslationFn } from "../../i18n";
import { cachedDateTimeFormat, cachedNumberFormat } from "../../intl-formatters";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { AppIdentityIcon, resolveGroveAppIconName } from "../ui/grove-app-icon";
import { MotionMenu, MotionMenuItem, MotionMenuSurface } from "../ui/motion/menu";
import { NameAvatar } from "../ui/name-avatar";
import { ProductIcon, type ProductIconName } from "../ui/product-icon";
import { UnreadCountAnchor, type UnreadCountVariant } from "../ui/unread-count";
import type { BridgeAuthUser } from "../../bridge";
import { updateAccountProfile } from "../../account-profile-api";
import { accountProfileLoadAction } from "../../account-profile-policy";
import {
  readAccountProfile,
  resolveAccountProfileUserId,
  writeAccountProfile,
  type AccountProfile,
} from "../../runtime/account-profile-store";
import { getClientBootstrap } from "../../runtime/client-bootstrap";
import { readDesktopApi } from "../../desktop-api";
import type { DevFixtureAccount } from "../../dev-fixture-accounts";
import { devFixtureAccountCopy } from "../../locales/dev-fixture-account-copy";
import {
  createH5SignApplication,
  createPayoutOrder,
  createPayoutProfileVerification,
  createStripeOnboardingLink,
  extractPaymentSigned,
  extractPaymentStatus,
  extractPaymentUrl,
  extractPayoutOrderId,
  extractStripeHostedOnboardingUrl,
  extractWithdrawalPublicErrorName,
  extractWithdrawalVerificationFailure,
  isWithdrawalAuthExpiredError,
  isWithdrawalRecordInProgress,
  readWithdrawalContractState,
  readWithdrawalOverviewStatus,
  readPayoutOrder,
  readWithdrawalRecordsPage,
  readWithdrawalStatus,
  syncStripeConnectStatus,
  syncPayoutOrder,
  withdrawalRecordStatusKind,
  type WithdrawalContractState,
  type WithdrawalRecord,
  type WithdrawalRecordsPage,
  type WithdrawalProfileFieldErrors,
  type WithdrawalStatus,
} from "../../withdrawal-api";
import {
  shouldSyncStripeOnboardingOnMount,
  STRIPE_ONBOARDING_PAGE_ID,
  STRIPE_ONBOARDING_PENDING_KEY,
} from "../../stripe-onboarding-lifecycle";
import { nativeRailSectionVisible } from "./navigation-mode-policy";
import styles from "./app-navigation.module.css";

export type PixelIconName = AppIconName;
export type { RailSectionId } from "../../apps/catalog";

const PROFESSIONAL_ICONS: Record<PixelIconName, LucideIcon> = {
  chat: MessageSquare,
  rooms: MessagesSquare,
  messages: MessagesSquare,
  contacts: UserRound,
  library: FileText,
  folder: BookOpenText,
  document: FileText,
  seed: Sprout,
  search: BookOpenText,
  plus: Plus,
  settings: Settings,
  user: UserRound,
  ops: Activity,
  store: Store,
  extensions: Package,
};

const PRIMARY_RAIL_APPS = RAIL_APPS.filter((app) => app.layer !== "user");
const CONFIGURATION_RAIL_APPS = PRIMARY_RAIL_APPS.filter((app) => app.section === "extensions");
const NETWORK_RAIL_APPS = PRIMARY_RAIL_APPS.filter((app) => app.section === "network");
const NATIVE_RAIL_APPS = PRIMARY_RAIL_APPS.filter((app) => app.section !== "extensions" && app.section !== "network");
const WITHDRAWAL_MIN_CENTS = 100;
const WITHDRAWAL_RECORDS_PAGE_SIZE = 20;
const WITHDRAWAL_CONTRACT_POLL_INTERVAL_MS = 10_000;
const WITHDRAWAL_CONTRACT_POLL_MAX_MS = 5 * 60 * 1000;
const WITHDRAWAL_TOAST_DURATION_MS = 5_000;
type WithdrawalStep =
  | "overview"
  | "identity"
  | "identity_success"
  | "contract"
  | "confirm"
  | "records"
  | "success"
  | "stripe_consent"
  | "stripe_setup"
  | "stripe_review"
  | "stripe_unavailable"
  | "stripe_progress";
type WithdrawalPendingAction =
  | "identity_submit"
  | "h5_sign_application"
  | "h5_sign_status"
  | "payout_order"
  | "status_refresh"
  | "stripe_onboarding"
  | "stripe_sync"
  | "stripe_order_sync";

type WithdrawalStatusPlaceholder = WithdrawalStatus;

interface WithdrawalRuntimeState {
  error: string;
  pendingAction: WithdrawalPendingAction | null;
  signingUrl: string;
}

interface WithdrawalLatestPayoutNotice {
  amountCents: number;
  currency: WithdrawalStatus["settlement"]["currency"];
}

interface WithdrawalRecordsPageState extends WithdrawalRecordsPage {
  error: string;
  loading: boolean;
  loadingMore: boolean;
  syncing: boolean;
}

interface WithdrawalIdentityForm {
  realName: string;
  idCard: string;
  phoneNo: string;
  cardNo: string;
}

type WithdrawalIdentityErrors = Partial<Record<keyof WithdrawalIdentityForm, string>>;

const EMPTY_WITHDRAWAL_STATUS: WithdrawalStatusPlaceholder = {
  settlement: { countryCode: "CN", provider: "yunzhanghu", currency: "CNY" },
  stripeConnect: null,
  balanceCents: 0,
  withdrawalCount: 0,
  totalEarningsCents: 0,
  frozenCents: 0,
  totalWithdrawnCents: 0,
  identityInfoStatus: "missing",
  bankCardStatus: "missing",
  contractStatus: "not_started",
  signingUrl: "",
  bankCardLast4: "",
  profileFieldErrors: {},
  payoutInProgress: false,
  activePayout: null,
  withdrawalRecords: [],
  recordsStatus: "ready",
};

const EMPTY_WITHDRAWAL_RUNTIME: WithdrawalRuntimeState = {
  error: "",
  pendingAction: null,
  signingUrl: "",
};

const EMPTY_WITHDRAWAL_RECORDS_PAGE_STATE: WithdrawalRecordsPageState = {
  error: "",
  loading: false,
  loadingMore: false,
  syncing: false,
  page: 0,
  pageSize: WITHDRAWAL_RECORDS_PAGE_SIZE,
  records: [],
  total: 0,
};

const EMPTY_WITHDRAWAL_IDENTITY_FORM: WithdrawalIdentityForm = {
  realName: "",
  idCard: "",
  phoneNo: "",
  cardNo: "",
};

function createWithdrawalLatestPayoutNotice(
  activePayout: WithdrawalStatusPlaceholder["activePayout"],
): WithdrawalLatestPayoutNotice | null {
  if (!activePayout || !isWithdrawalRecordInProgress(activePayout.status)) return null;
  return {
    amountCents: activePayout.amountCents,
    currency: activePayout.currency,
  };
}

function findLatestSyncableWithdrawalRecord(records: WithdrawalRecord[]): WithdrawalRecord | null {
  return records.find((record) => isWithdrawalRecordInProgress(record)) ?? null;
}

function activePayoutFromWithdrawalRecords(
  records: WithdrawalRecord[],
  provider?: WithdrawalStatus["settlement"]["provider"],
): WithdrawalStatusPlaceholder["activePayout"] {
  const record = findLatestSyncableWithdrawalRecord(
    provider ? records.filter((item) => item.provider === provider) : records,
  );
  return record
    ? {
        actionRequired: record.actionRequired,
        amountCents: record.amountCents,
        createdAt: record.createdAt,
        currency: record.currency,
        orderId: record.id,
        provider: record.provider,
        providerStatus: record.providerStatus,
        status: record.status,
      }
    : null;
}

function withdrawalActivePayoutFromRecord(
  record: WithdrawalRecord,
): NonNullable<WithdrawalStatusPlaceholder["activePayout"]> {
  return {
    actionRequired: record.actionRequired,
    amountCents: record.amountCents,
    createdAt: record.createdAt,
    currency: record.currency,
    orderId: record.id,
    provider: record.provider,
    providerStatus: record.providerStatus,
    status: record.status,
  };
}

function stripeOrderPollingComplete(status: string, providerStatus: string): boolean {
  return (
    status === "paid" ||
    providerStatus === "paid" ||
    providerStatus === "payout_action_required" ||
    providerStatus === "review_required" ||
    status === "review_required"
  );
}

function stripeActivePayoutStatusLabel(payout: WithdrawalStatusPlaceholder["activePayout"], t: TranslationFn): string {
  if (!payout) return t("withdrawal.recordProcessing");
  switch (withdrawalRecordStatusKind(payout)) {
    case "funds_preparing":
      return t("withdrawal.stripeFundsPreparing");
    case "bank_processing":
      return t("withdrawal.stripeBankProcessing");
    case "action_required":
      return t("withdrawal.stripeUpdateBankRequired");
    case "review_required":
      return t("withdrawal.stripeOrderReview");
    case "paid":
      return t("withdrawal.recordPaid");
    case "failed":
      return t("withdrawal.recordFailed");
    case "processing":
    case "unknown":
      return t("withdrawal.recordProcessing");
  }
}

function mergeWithdrawalRecords(existing: WithdrawalRecord[], incoming: WithdrawalRecord[]): WithdrawalRecord[] {
  const seen = new Set(existing.map((record) => record.id));
  return [
    ...existing,
    ...incoming.filter((record) => {
      if (seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    }),
  ];
}

function isWithdrawalProfileVerified(status: WithdrawalStatusPlaceholder): boolean {
  return status.identityInfoStatus === "verified" && status.bankCardStatus === "verified";
}

function isWithdrawalProfilePending(status: WithdrawalStatusPlaceholder): boolean {
  return status.identityInfoStatus === "pending" || status.bankCardStatus === "pending";
}

function isWithdrawalProfileRejected(status: WithdrawalStatusPlaceholder): boolean {
  return status.identityInfoStatus === "rejected" || status.bankCardStatus === "rejected";
}

function mergeWithdrawalProfileFieldErrors(
  primary: WithdrawalProfileFieldErrors,
  secondary: WithdrawalProfileFieldErrors,
): WithdrawalProfileFieldErrors {
  return Object.fromEntries(
    Object.entries({
      ...secondary,
      ...primary,
    }).filter(([, value]) => value?.trim()),
  ) as WithdrawalProfileFieldErrors;
}

function hasWithdrawalProfileFieldErrors(errors: WithdrawalProfileFieldErrors): boolean {
  return Object.values(errors).some((value) => Boolean(value?.trim()));
}

function withdrawalVerificationFailureProductMessage(
  failure: { message: string },
  phase: "identity" | "bank_card",
  t: TranslationFn,
): string {
  if (failure.message.includes("稍后")) return t("withdrawal.retryLater");
  return phase === "identity" ? t("withdrawal.errorIdentityMismatch") : t("withdrawal.errorBankMismatch");
}

function withdrawalProfileStatusMessage(status: WithdrawalStatusPlaceholder, t: TranslationFn): string {
  const publicErrorMessage = translatedWithdrawalProfileError(status, t);
  if (publicErrorMessage) return publicErrorMessage;
  if (!isWithdrawalProfileRejected(status) && !hasWithdrawalProfileFieldErrors(status.profileFieldErrors)) return "";
  if (status.profileFieldErrors.cardNo || status.profileFieldErrors.phoneNo || status.bankCardStatus === "rejected") {
    return t("withdrawal.errorBankMismatch");
  }
  if (
    status.profileFieldErrors.realName ||
    status.profileFieldErrors.idCard ||
    status.identityInfoStatus === "rejected"
  ) {
    return t("withdrawal.errorIdentityMismatch");
  }
  return t("withdrawal.retryLater");
}

function accountUsername(user: BridgeAuthUser | undefined): string {
  const email = user?.email?.trim();
  const displayName = user?.displayName?.trim();
  if (displayName && displayName !== email) return displayName;
  if (email?.includes("@")) return email.split("@")[0] || email;
  return displayName || email || user?.userId || "";
}

function usernameWithLocalProfile(
  user: BridgeAuthUser | undefined,
  profile: Partial<AccountProfile>,
  t: TranslationFn,
): string {
  return profile.username?.trim() || accountUsername(user) || t("nav.account");
}

function withdrawalDialogTitle(step: WithdrawalStep, t: TranslationFn): string {
  if (step === "stripe_consent") return t("withdrawal.stripeConsentTitle");
  if (step === "stripe_setup") return t("withdrawal.stripeSetupTitle");
  if (step === "stripe_review") return t("withdrawal.stripeReviewTitle");
  if (step === "stripe_unavailable") return t("withdrawal.stripeUnavailableTitle");
  if (step === "stripe_progress") return t("withdrawal.stripeProgressTitle");
  if (step === "identity") return t("withdrawal.titleIdentity");
  if (step === "identity_success") return t("withdrawal.titleIdentitySuccess");
  if (step === "contract") return t("withdrawal.titleContract");
  if (step === "confirm") return t("withdrawal.titleConfirm");
  if (step === "records") return t("withdrawal.titleRecords");
  if (step === "success") return t("withdrawal.titleSuccess");
  return t("withdrawal.title");
}

function translatedWithdrawalProfileError(value: unknown, t: TranslationFn): string {
  switch (extractWithdrawalPublicErrorName(value)) {
    case "PAYOUT_PROFILE_ALREADY_EXISTS":
      return t("withdrawal.errorProfileExists");
    case "ID_CARD_ALREADY_BOUND":
      return t("withdrawal.errorIdCardBound");
    case "IDENTITY_VERIFICATION_FAILED":
      return t("withdrawal.errorIdentityMismatch");
    case "BANK_CARD_VERIFICATION_FAILED":
      return t("withdrawal.errorBankMismatch");
    case "YZH_UNAVAILABLE":
      return t("withdrawal.retryLater");
    default:
      return "";
  }
}

function translatedWithdrawalSignError(value: unknown, t: TranslationFn): string {
  switch (extractWithdrawalPublicErrorName(value)) {
    case "SIGN_APPLICATION_IN_PROGRESS":
      return t("withdrawal.errorSignInProgress");
    case "YZH_UNAVAILABLE":
      return t("withdrawal.retryLater");
    default:
      return "";
  }
}

function translatedWithdrawalPayoutError(value: unknown, t: TranslationFn): string {
  if (value instanceof Error && value.message === "withdrawal_payout_failed") {
    return t("withdrawal.errorPayoutFailed");
  }
  switch (extractWithdrawalPublicErrorName(value)) {
    case "PAYOUT_PROFILE_REQUIRED":
      return t("withdrawal.errorProfileRequired");
    case "SIGN_REQUIRED":
      return t("withdrawal.errorSignRequired");
    case "NO_WITHDRAWABLE_BALANCE":
      return t("withdrawal.noBalance");
    case "PAYOUT_REQUEST_IN_PROGRESS":
      return t("withdrawal.payoutInProgress");
    case "PAYOUT_DAILY_LIMIT_EXCEEDED":
      return t("withdrawal.errorDailyLimit");
    case "STRIPE_CONSENT_REQUIRED":
      return t("withdrawal.stripeConsentRequired");
    case "STRIPE_CONNECT_NOT_READY":
      return t("withdrawal.stripeConnectNotReady");
    case "STRIPE_UNAVAILABLE":
      return t("withdrawal.stripeUnavailableCopy");
    case "PAYOUT_AMOUNT_LIMIT_EXCEEDED":
      return t("withdrawal.errorStripeAmountLimit");
    case "SERVICE_UNAVAILABLE":
      return t("withdrawal.errorServiceUnavailable");
    default:
      return "";
  }
}

function translatedWithdrawalSyncError(value: unknown, t: TranslationFn): string {
  return extractWithdrawalPublicErrorName(value) === "SERVICE_UNAVAILABLE"
    ? t("withdrawal.errorServiceUnavailable")
    : "";
}

export function railSectionForView(view: ViewId): RailSectionId {
  return catalogRailSectionForView(view);
}

export interface RailSectionBadge {
  count: number;
  variant?: UnreadCountVariant;
}

export function AppRail(props: {
  activeSection: RailSectionId;
  expanded: boolean;
  developerMode?: boolean;
  directKernelChatEnabled?: boolean;
  authUser?: BridgeAuthUser;
  fixtureAccountSwitchError?: string;
  fixtureAccountSwitchingEmail?: string;
  fixtureAccounts?: readonly DevFixtureAccount[];
  previousAccountEmail?: string;
  restoringPreviousAccount?: boolean;
  onRestorePreviousAccount?(): void;
  onAuthExpired?(): void;
  onLogin?(): void;
  onLogout?(): void;
  onSwitchFixtureAccount?(account: DevFixtureAccount): void;
  onOpenSection(section: RailSectionId): void;
  onOpenSettings(): void;
  onCreateApp(): void;
  onSelectMountedApp?(appId: string): void;
  onManageMountedAppVersions?(appId: string): void;
  onEditMountedApp?(appId: string): void;
  onDeleteMountedApp?(appId: string): void;
  mountedApps?: ExtensionItemRecord[];
  activeMountedAppId?: string;
  sectionBadges?: Partial<Record<RailSectionId, RailSectionBadge>>;
  mountedAppBadges?: Partial<Record<string, RailSectionBadge>>;
}) {
  const { language, t } = useI18n();
  const fixtureAccountCopy = __OPENGROVE_DEV_FIXTURE_ACCOUNTS__ ? devFixtureAccountCopy(language) : undefined;
  const { preference: iconStyle } = useIconStylePreference();
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [fixtureAccountDialogOpen, setFixtureAccountDialogOpen] = useState(false);
  const [requestedFixtureEmail, setRequestedFixtureEmail] = useState("");
  const [withdrawalDialogOpen, setWithdrawalDialogOpen] = useState(false);
  const [withdrawalStep, setWithdrawalStep] = useState<WithdrawalStep>("overview");
  const [withdrawalRuntime, setWithdrawalRuntime] = useState<WithdrawalRuntimeState>(EMPTY_WITHDRAWAL_RUNTIME);
  const [withdrawalStatus, setWithdrawalStatus] = useState<WithdrawalStatusPlaceholder>(EMPTY_WITHDRAWAL_STATUS);
  const [withdrawalRecordsPage, setWithdrawalRecordsPage] = useState<WithdrawalRecordsPageState>(
    EMPTY_WITHDRAWAL_RECORDS_PAGE_STATE,
  );
  const [withdrawalToastMessage, setWithdrawalToastMessage] = useState("");
  const [localProfile, setLocalProfile] = useState<Partial<AccountProfile>>({});
  const [profileUsername, setProfileUsername] = useState("");
  const [profileAvatarSource, setProfileAvatarSource] = useState("");
  const [profileError, setProfileError] = useState("");
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const attemptedProfileMigrationsThisMountRef = useRef(new Set<string>());
  const withdrawalRecordsRequestRef = useRef(0);
  const developerMode = props.developerMode === true;
  const directKernelChatEnabled = props.directKernelChatEnabled === true;
  const mountedApps = [...(props.mountedApps ?? [])].sort((a, b) => compareLocalizedText(a.title, b.title));
  const profileKey = resolveAccountProfileUserId(props.authUser?.userId, getClientBootstrap().environment.preset) ?? "";
  const activeProfileKeyRef = useRef(profileKey);
  const username = usernameWithLocalProfile(props.authUser, localProfile, t);
  const avatarSource = localProfile.avatarUrl?.trim() || props.authUser?.avatarUrl?.trim() || "";
  const accountRegionCode = props.authUser?.countryCode?.trim().toUpperCase() || "";
  const accountRegionLabel = countryLabelForLocale(accountRegionCode, language);
  const withdrawalAllowed = Boolean(props.authUser?.userId || props.authUser?.email);
  const withdrawalHeaderHasBack =
    withdrawalStep === "identity" ||
    withdrawalStep === "contract" ||
    withdrawalStep === "confirm" ||
    withdrawalStep === "records" ||
    withdrawalStep === "stripe_consent" ||
    withdrawalStep === "stripe_setup" ||
    withdrawalStep === "stripe_review" ||
    withdrawalStep === "stripe_unavailable" ||
    withdrawalStep === "stripe_progress";
  const latestPayoutNotice = createWithdrawalLatestPayoutNotice(withdrawalStatus.activePayout);
  const visibleNativeRailApps = NATIVE_RAIL_APPS.filter((app) =>
    nativeRailSectionVisible(app.section, developerMode, directKernelChatEnabled),
  );

  useEffect(() => {
    let active = true;
    if (activeProfileKeyRef.current !== profileKey) {
      activeProfileKeyRef.current = profileKey;
      setLocalProfile({});
    }
    if (profileKey) {
      void (async () => {
        const cachedProfile = await readAccountProfile(profileKey);
        const authenticatedUser = props.authUser;
        if (!authenticatedUser?.userId) {
          if (active) setLocalProfile(cachedProfile ?? {});
          return;
        }
        const cachedAvatar = cachedProfile?.avatarUrl?.trim() || "";
        const hasCachedProfile = Boolean(cachedProfile?.username?.trim() || cachedAvatar);
        const loadAction = accountProfileLoadAction(authenticatedUser, hasCachedProfile);
        if (loadAction === "use-remote") {
          const remoteProfile = {
            username: accountUsername(authenticatedUser),
            ...(authenticatedUser.avatarUrl ? { avatarUrl: authenticatedUser.avatarUrl } : {}),
          };
          if (active) setLocalProfile(remoteProfile);
          await writeAccountProfile(profileKey, remoteProfile);
          return;
        }
        if (loadAction === "migrate-cache" && !attemptedProfileMigrationsThisMountRef.current.has(profileKey)) {
          attemptedProfileMigrationsThisMountRef.current.add(profileKey);
          try {
            const migratedUser = await updateAccountProfile({
              displayName: cachedProfile?.username?.trim() || accountUsername(authenticatedUser),
              ...(cachedAvatar.startsWith("data:image/jpeg;base64,") ? { avatarDataUrl: cachedAvatar } : {}),
            });
            const migratedProfile = await writeAccountProfile(profileKey, {
              username: accountUsername(migratedUser),
              ...(migratedUser.avatarUrl ? { avatarUrl: migratedUser.avatarUrl } : {}),
            });
            if (active) setLocalProfile(migratedProfile);
            return;
          } catch (error) {
            console.error("[opengrove-ui] account profile migration failed", error);
          }
        }
        if (active) setLocalProfile(cachedProfile ?? {});
      })().catch((error: unknown) => {
        console.error("[opengrove-ui] account profile read failed", error);
      });
    }
    return () => {
      active = false;
    };
  }, [
    profileKey,
    props.authUser?.avatarUrl,
    props.authUser?.displayName,
    props.authUser?.email,
    props.authUser?.profileStatus,
    props.authUser?.profileUpdatedAt,
    props.authUser?.userId,
  ]);

  useEffect(() => {
    if (!accountDialogOpen) return;
    setProfileError("");
    setProfileUsername(username);
    setProfileAvatarSource(avatarSource);
  }, [accountDialogOpen, avatarSource, username]);

  useEffect(() => {
    if (!requestedFixtureEmail || props.fixtureAccountSwitchingEmail) return;
    if (props.authUser?.email === requestedFixtureEmail) {
      setFixtureAccountDialogOpen(false);
      setRequestedFixtureEmail("");
    }
  }, [props.authUser?.email, props.fixtureAccountSwitchingEmail, requestedFixtureEmail]);

  useEffect(() => {
    if (!withdrawalToastMessage) return undefined;
    const timer = window.setTimeout(() => setWithdrawalToastMessage(""), WITHDRAWAL_TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [withdrawalToastMessage]);

  useEffect(() => {
    if (!withdrawalDialogOpen) return;
    let active = true;
    setWithdrawalStep("overview");
    setWithdrawalRuntime({ ...EMPTY_WITHDRAWAL_RUNTIME, pendingAction: "status_refresh" });
    setWithdrawalToastMessage("");
    setWithdrawalStatus(EMPTY_WITHDRAWAL_STATUS);
    setWithdrawalRecordsPage(EMPTY_WITHDRAWAL_RECORDS_PAGE_STATE);
    void readWithdrawalOverviewStatus()
      .then((response) => {
        if (!active) return;
        handleWithdrawalStatusChange(response);
      })
      .catch((error) => {
        if (!active) return;
        if (isWithdrawalAuthExpiredError(error)) {
          handleWithdrawalAuthExpired();
          return;
        }
        setWithdrawalRuntime((runtime) => ({ ...runtime, error: apiErrorMessage(t) }));
      })
      .finally(() => {
        if (active) setWithdrawalRuntime((runtime) => ({ ...runtime, pendingAction: null }));
      });
    return () => {
      active = false;
    };
  }, [language, withdrawalDialogOpen, t]);

  useEffect(() => {
    if (!withdrawalAllowed) {
      window.sessionStorage.removeItem(STRIPE_ONBOARDING_PENDING_KEY);
      setWithdrawalDialogOpen(false);
    }
  }, [withdrawalAllowed]);

  useEffect(() => {
    const desktop = readDesktopApi();
    return desktop?.onStripeDeepLink?.((deepLink) => {
      window.sessionStorage.setItem(STRIPE_ONBOARDING_PENDING_KEY, `desktop-deep-link:${deepLink.action}`);
      if (withdrawalAllowed) setWithdrawalDialogOpen(true);
    });
  }, [withdrawalAllowed]);

  useEffect(() => {
    if (!withdrawalAllowed) return;
    const pending = window.sessionStorage.getItem(STRIPE_ONBOARDING_PENDING_KEY) ?? "";
    if (pending.startsWith("desktop-deep-link:")) setWithdrawalDialogOpen(true);
  }, [withdrawalAllowed]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && accountMenuRef.current?.contains(target)) return;
      setAccountMenuOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountMenuOpen(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  function openAccountDetails() {
    setAccountMenuOpen(false);
    setAccountDialogOpen(true);
  }

  function openHelpFromAccountMenu() {
    setAccountMenuOpen(false);
    window.open("https://github.com/open-grove/opengrove#readme", "_blank", "noopener,noreferrer");
  }

  function openWithdrawalFromAccountMenu() {
    setAccountMenuOpen(false);
    if (!withdrawalAllowed) return;
    setWithdrawalDialogOpen(true);
  }

  function handleWithdrawalAuthExpired(): void {
    setAccountMenuOpen(false);
    closeWithdrawalDialog();
    setWithdrawalRuntime(EMPTY_WITHDRAWAL_RUNTIME);
    props.onAuthExpired?.();
  }

  function closeWithdrawalDialog(): void {
    window.sessionStorage.removeItem(STRIPE_ONBOARDING_PENDING_KEY);
    setWithdrawalDialogOpen(false);
  }

  function handleWithdrawalDialogOpenChange(open: boolean): void {
    if (open) {
      setWithdrawalDialogOpen(true);
      return;
    }
    closeWithdrawalDialog();
  }

  function showWithdrawalToast(message: string): void {
    if (!message.trim()) return;
    setWithdrawalToastMessage("");
    window.setTimeout(() => setWithdrawalToastMessage(message), 0);
  }

  function handleWithdrawalStatusChange(status: WithdrawalStatusPlaceholder) {
    setWithdrawalStatus(status);
  }

  function handleWithdrawalContractStateChange(state: WithdrawalContractState) {
    setWithdrawalStatus((status) => ({ ...status, ...state }));
  }

  function completeWithdrawalSuccess() {
    setWithdrawalRuntime((runtime) => ({ ...runtime, error: "" }));
    setWithdrawalStep("overview");
  }

  function updateWithdrawalStep(step: WithdrawalStep) {
    if (step === "overview") {
      setWithdrawalRuntime((runtime) => (runtime.error ? { ...runtime, error: "" } : runtime));
    }
    setWithdrawalStep(step);
  }

  function openWithdrawalRecords() {
    setWithdrawalStep("records");
    if (!withdrawalRecordsPage.loading) {
      void loadWithdrawalRecordsPage(1, false);
    }
  }

  function loadMoreWithdrawalRecords() {
    const total = withdrawalRecordsPage.total || withdrawalStatus.withdrawalCount;
    if (withdrawalRecordsPage.loading || withdrawalRecordsPage.loadingMore) return;
    if (withdrawalRecordsPage.records.length >= total) return;
    void loadWithdrawalRecordsPage(withdrawalRecordsPage.page + 1 || 1, true);
  }

  async function loadWithdrawalRecordsPage(page: number, append: boolean): Promise<void> {
    const requestId = withdrawalRecordsRequestRef.current + 1;
    withdrawalRecordsRequestRef.current = requestId;
    setWithdrawalRecordsPage((state) => ({
      ...state,
      error: "",
      loading: !append,
      loadingMore: append,
    }));
    try {
      const pageResult = await readWithdrawalRecordsPage(page, WITHDRAWAL_RECORDS_PAGE_SIZE);
      if (withdrawalRecordsRequestRef.current !== requestId) return;
      const pageActivePayout =
        page === 1 ? activePayoutFromWithdrawalRecords(pageResult.records, withdrawalStatus.settlement.provider) : null;
      setWithdrawalRecordsPage((state) => {
        const records = append ? mergeWithdrawalRecords(state.records, pageResult.records) : pageResult.records;
        return {
          ...state,
          error: "",
          loading: false,
          loadingMore: false,
          page: pageResult.page,
          pageSize: pageResult.pageSize,
          records,
          total: pageResult.total,
        };
      });
      setWithdrawalStatus((status) => ({
        ...status,
        withdrawalCount: pageResult.total,
        recordsStatus: "ready",
        ...(page === 1
          ? {
              activePayout: pageActivePayout,
              payoutInProgress: pageActivePayout !== null,
              withdrawalRecords: pageResult.records,
            }
          : {}),
      }));
    } catch (error) {
      if (withdrawalRecordsRequestRef.current !== requestId) return;
      const publicErrorName = extractWithdrawalPublicErrorName(error);
      if (isWithdrawalAuthExpiredError(error)) {
        handleWithdrawalAuthExpired();
        return;
      }
      if (publicErrorName === "SERVICE_UNAVAILABLE") {
        setWithdrawalRecordsPage((state) => ({
          ...state,
          error: t("withdrawal.recordsLoadFailed"),
          loading: false,
          loadingMore: false,
        }));
        return;
      }
      setWithdrawalRecordsPage((state) => ({
        ...state,
        error: apiErrorMessage(t),
        loading: false,
        loadingMore: false,
      }));
    }
  }

  async function refreshWithdrawalRecordsStatus() {
    const record = findLatestSyncableWithdrawalRecord(
      withdrawalRecordsPage.records.filter((item) => item.provider === withdrawalStatus.settlement.provider),
    );
    if (withdrawalRecordsPage.syncing) return;
    setWithdrawalRecordsPage((state) => ({ ...state, error: "", syncing: true }));
    try {
      if (record) {
        const response = await syncPayoutOrder(record.id);
        assertWithdrawalApiOk(response);
      }
      await Promise.all([
        loadWithdrawalRecordsPage(1, false),
        readWithdrawalStatus().then(handleWithdrawalStatusChange),
      ]);
    } catch (error) {
      const publicErrorName = extractWithdrawalPublicErrorName(error);
      if (isWithdrawalAuthExpiredError(error)) {
        handleWithdrawalAuthExpired();
        return;
      }
      if (publicErrorName === "SERVICE_UNAVAILABLE") {
        showWithdrawalToast(translatedWithdrawalSyncError(error, t));
        setWithdrawalRecordsPage((state) => ({ ...state, error: "" }));
        return;
      }
      setWithdrawalRecordsPage((state) => ({
        ...state,
        error: translatedWithdrawalSyncError(error, t) || apiErrorMessage(t),
      }));
    } finally {
      setWithdrawalRecordsPage((state) => ({ ...state, syncing: false }));
    }
  }

  async function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileKey) {
      setProfileError(t("nav.profileLoginRequired"));
      return;
    }
    try {
      const displayName = profileUsername.trim() || null;
      const avatarDataUrl = profileAvatarSource.startsWith("data:image/jpeg;base64,")
        ? profileAvatarSource
        : !profileAvatarSource && avatarSource
          ? null
          : undefined;
      const updatedUser = props.authUser?.userId
        ? await updateAccountProfile({
            displayName,
            ...(avatarDataUrl !== undefined ? { avatarDataUrl } : {}),
          })
        : undefined;
      const nextProfile = await writeAccountProfile(
        profileKey,
        updatedUser
          ? {
              username: accountUsername(updatedUser),
              ...(updatedUser.avatarUrl ? { avatarUrl: updatedUser.avatarUrl } : {}),
            }
          : {
              ...(displayName ? { username: displayName } : {}),
              ...(profileAvatarSource ? { avatarUrl: profileAvatarSource } : {}),
            },
      );
      setLocalProfile(nextProfile);
      setAccountDialogOpen(false);
    } catch (error) {
      console.error("[opengrove-ui] account profile write failed", error);
      setProfileError(t("nav.profileSaveFailed"));
    }
  }

  async function changeAvatar(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    setProfileAvatarSource(await avatarFileToDataUrl(file));
  }

  return (
    <aside
      className={clsx("app-rail", styles.rail)}
      data-expanded={props.expanded ? "true" : "false"}
      aria-label={t("app.mainNav")}
    >
      <nav className={clsx("app-rail-nav", styles.nav)}>
        {visibleNativeRailApps.length ? (
          <RailSection title={t("app.nativeApps")}>
            {visibleNativeRailApps.map((app) => (
              <RailButton
                key={app.id}
                active={props.activeSection === app.section}
                sectionTarget={app.section}
                label={appNavLabel(app.view, t)}
                icon={app.icon}
                professionalIcon={PROFESSIONAL_ICONS[app.icon]}
                iconStyle={iconStyle}
                badge={props.sectionBadges?.[app.section]}
                onClick={() => props.onOpenSection(app.section)}
              />
            ))}
          </RailSection>
        ) : null}
        <RailSection title={t("app.loadedApps")}>
          <div className={clsx("app-rail-user-app-tabs", styles.userAppTabs)} aria-label={t("app.userApps")}>
            {mountedApps.map((app) => (
              <UserAppRailItem
                key={app.id}
                active={props.activeSection === "apps" && app.name === props.activeMountedAppId}
                id={app.name}
                title={app.title}
                appIcon={mountedAppIcon(app)}
                badge={props.mountedAppBadges?.[app.name]}
                onClick={() => props.onSelectMountedApp?.(app.name)}
                onManageVersions={props.onManageMountedAppVersions}
                onEdit={props.onEditMountedApp}
                onDelete={props.onDeleteMountedApp}
                deleteLabel={t("common.delete")}
              />
            ))}
            {developerMode ? (
              <RailButton
                active={false}
                label={t("app.createApp")}
                icon="plus"
                professionalIcon={Plus}
                iconStyle={iconStyle}
                onClick={props.onCreateApp}
              />
            ) : null}
          </div>
        </RailSection>
        <RailSection title={t("app.network")}>
          {NETWORK_RAIL_APPS.map((app) => (
            <RailButton
              key={app.id}
              active={props.activeSection === app.section}
              sectionTarget={app.section}
              label={appNavLabel(app.view, t)}
              icon={app.icon}
              professionalIcon={PROFESSIONAL_ICONS[app.icon]}
              iconStyle={iconStyle}
              badge={props.sectionBadges?.[app.section]}
              onClick={() => props.onOpenSection(app.section)}
            />
          ))}
        </RailSection>
        <RailSection title={t("app.configuration")}>
          {developerMode
            ? CONFIGURATION_RAIL_APPS.map((app) => (
                <RailButton
                  key={app.id}
                  active={props.activeSection === app.section}
                  sectionTarget={app.section}
                  label={appNavLabel(app.view, t)}
                  icon={app.icon}
                  professionalIcon={PROFESSIONAL_ICONS[app.icon]}
                  iconStyle={iconStyle}
                  badge={props.sectionBadges?.[app.section]}
                  onClick={() => props.onOpenSection(app.section)}
                />
              ))
            : null}
          <RailButton
            active={props.activeSection === "settings"}
            sectionTarget="settings"
            label={t("app.settings")}
            icon="settings"
            professionalIcon={Settings}
            iconStyle={iconStyle}
            badge={props.sectionBadges?.settings}
            onClick={props.onOpenSettings}
          />
        </RailSection>
      </nav>
      <div className={clsx("app-rail-bottom", styles.bottom)} ref={accountMenuRef}>
        <button
          className={clsx("app-user-button", styles.userButton)}
          data-active={accountMenuOpen || accountDialogOpen || fixtureAccountDialogOpen ? "true" : "false"}
          data-tooltip={t("nav.account")}
          type="button"
          onClick={() => setAccountMenuOpen((open) => !open)}
          aria-label={t("nav.account")}
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen}
          title={t("nav.account")}
        >
          <span className={styles.userButtonAvatar}>
            <NameAvatar name={username} src={avatarSource} />
          </span>
          <strong className={styles.userButtonName}>{username}</strong>
        </button>
        {accountMenuOpen ? (
          <MotionMenuSurface
            className={clsx("app-account-menu", styles.accountMenu)}
            role="menu"
            size="content"
            aria-label={t("nav.account")}
          >
            <button
              className={clsx("app-account-menu-profile", styles.accountMenuProfile)}
              type="button"
              role="menuitem"
              onClick={openAccountDetails}
            >
              <span className={clsx("app-account-menu-avatar", styles.accountMenuAvatar)} aria-hidden="true">
                <NameAvatar name={username} src={avatarSource} />
              </span>
              <span className={clsx("app-account-menu-copy", styles.accountMenuCopy)}>
                <strong>{username}</strong>
                <small>{t("nav.personalAccount")}</small>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            <div className={clsx("app-account-menu-divider", styles.accountMenuDivider)} />
            {props.onSwitchFixtureAccount && fixtureAccountCopy ? (
              <button
                className={clsx("app-account-menu-item", styles.accountMenuItem)}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  setFixtureAccountDialogOpen(true);
                }}
              >
                <RefreshCw size={18} aria-hidden="true" />
                <span>{fixtureAccountCopy.open}</span>
                <ChevronRight className={styles.accountMenuChevron} size={16} aria-hidden="true" />
              </button>
            ) : null}
            {props.onLogin ? (
              <button
                className={clsx("app-account-menu-item", styles.accountMenuItem)}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  props.onLogin?.();
                }}
              >
                <LogIn size={18} aria-hidden="true" />
                <span>{t("nav.login")}</span>
              </button>
            ) : null}
            {withdrawalAllowed ? (
              <button
                className={clsx("app-account-menu-item", styles.accountMenuItem)}
                type="button"
                role="menuitem"
                onClick={() => void openWithdrawalFromAccountMenu()}
              >
                <WalletCards size={18} aria-hidden="true" />
                <span>{t("withdrawal.title")}</span>
                <ChevronRight className={styles.accountMenuChevron} size={16} aria-hidden="true" />
              </button>
            ) : null}
            <button
              className={clsx("app-account-menu-item", styles.accountMenuItem)}
              type="button"
              role="menuitem"
              onClick={openHelpFromAccountMenu}
            >
              <HelpCircle size={18} aria-hidden="true" />
              <span>{t("nav.help")}</span>
              <ChevronRight className={styles.accountMenuChevron} size={16} aria-hidden="true" />
            </button>
            {props.onLogout ? (
              <button
                className={clsx("app-account-menu-item", styles.accountMenuItem)}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  props.onLogout?.();
                }}
              >
                <LogOut size={18} aria-hidden="true" />
                <span>{t("nav.logout")}</span>
              </button>
            ) : null}
          </MotionMenuSurface>
        ) : null}
      </div>
      {fixtureAccountCopy ? (
        <Dialog open={fixtureAccountDialogOpen} onOpenChange={setFixtureAccountDialogOpen}>
          <DialogContent className={styles.fixtureAccountDialog} aria-label={fixtureAccountCopy.title}>
            <DialogTitle>{fixtureAccountCopy.title}</DialogTitle>
            <p className={styles.fixtureAccountHint}>{fixtureAccountCopy.hint}</p>
            {props.fixtureAccountSwitchError ? (
              <p className={styles.fixtureAccountError} role="alert">
                {props.fixtureAccountSwitchError}
              </p>
            ) : null}
            <div className={styles.fixtureAccountList} role="list">
              {props.previousAccountEmail && props.onRestorePreviousAccount ? (
                // Same card as a test account, but spanning the grid and marked
                // as your own: it is the way back out of the switcher, not one
                // more identity to try. The real account is deliberately absent
                // from the list itself.
                <button
                  className={styles.fixtureAccountButton}
                  data-restore="true"
                  type="button"
                  role="listitem"
                  disabled={props.restoringPreviousAccount || Boolean(props.fixtureAccountSwitchingEmail)}
                  onClick={props.onRestorePreviousAccount}
                >
                  <span className={styles.fixtureAccountIdentity}>
                    <strong>{props.previousAccountEmail.split("@")[0]}</strong>
                    <small>{props.previousAccountEmail}</small>
                  </span>
                  <span className={styles.fixtureAccountMetadata}>
                    <span>{fixtureAccountCopy.yourAccount}</span>
                  </span>
                  <span className={styles.fixtureAccountState}>
                    {props.restoringPreviousAccount ? fixtureAccountCopy.restoring : fixtureAccountCopy.restoreAction}
                  </span>
                </button>
              ) : null}
              {(props.fixtureAccounts ?? []).map((account) => {
                const current = props.authUser?.email === account.email;
                const switching = props.fixtureAccountSwitchingEmail === account.email;
                return (
                  <button
                    key={account.email}
                    className={styles.fixtureAccountButton}
                    data-current={current ? "true" : "false"}
                    type="button"
                    role="listitem"
                    disabled={current || account.status !== "active" || Boolean(props.fixtureAccountSwitchingEmail)}
                    onClick={() => {
                      setRequestedFixtureEmail(account.email);
                      props.onSwitchFixtureAccount?.(account);
                    }}
                  >
                    <span className={styles.fixtureAccountIdentity}>
                      <strong>{account.email.replace("@example.test", "")}</strong>
                      <small>{account.email}</small>
                    </span>
                    <span className={styles.fixtureAccountMetadata}>
                      {account.status !== "active" ? <span>{account.status}</span> : null}
                      <span>
                        {account.roles.length > 0 ? account.roles.join(" + ") : fixtureAccountCopy.noRoles}
                      </span>
                    </span>
                    <span className={styles.fixtureAccountState}>
                      {switching
                        ? fixtureAccountCopy.switching
                        : current
                          ? fixtureAccountCopy.current
                          : fixtureAccountCopy.switchAction}
                    </span>
                  </button>
                );
              })}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      <Dialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen}>
        <DialogContent className={clsx("profile-dialog", styles.profileDialog)} aria-label={t("nav.editProfile")}>
          <DialogTitle>{t("nav.editProfile")}</DialogTitle>
          <form className={styles.profileDialogForm} onSubmit={submitProfile}>
            <div className={clsx("profile-dialog-avatar", styles.profileDialogAvatar)}>
              <NameAvatar name={profileUsername || username} src={profileAvatarSource} />
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                onChange={(event) => {
                  void changeAvatar(event.currentTarget.files?.[0]).catch((error: unknown) => {
                    console.error("[opengrove-ui] account avatar read failed", error);
                    setProfileError(t("nav.avatarReadFailed"));
                  });
                  event.currentTarget.value = "";
                }}
              />
              <button
                className={styles.profileDialogAvatarChange}
                type="button"
                aria-label={t("nav.changeAvatar")}
                onClick={() => avatarInputRef.current?.click()}
              >
                <Camera aria-hidden="true" />
              </button>
              {profileAvatarSource ? (
                <button
                  className={styles.profileDialogAvatarRemove}
                  type="button"
                  aria-label={t("nav.removeAvatar")}
                  onClick={() => setProfileAvatarSource("")}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <label className={styles.profileDialogField}>
              <span>{t("nav.usernameLabel")}</span>
              <input
                value={profileUsername}
                onChange={(event) => setProfileUsername(event.currentTarget.value)}
                autoComplete="username"
                maxLength={80}
              />
            </label>
            {accountRegionLabel ? (
              <div
                className={clsx(styles.profileDialogField, styles.profileDialogReadonlyField)}
                role="group"
                aria-label={t("nav.accountRegionLabel")}
              >
                <span>{t("nav.accountRegionLabel")}</span>
                <div className={styles.profileDialogReadonlyValue}>
                  <strong>
                    {accountRegionLabel} ({accountRegionCode})
                  </strong>
                  <small>{t("nav.accountRegionLocked")}</small>
                </div>
              </div>
            ) : null}
            {profileError ? <p role="alert">{profileError}</p> : null}
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setAccountDialogOpen(false)}>
                {t("common.cancel")}
              </button>
              <button className="primary-button" type="submit">
                {t("filePreview.save")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {withdrawalAllowed ? (
        <Dialog open={withdrawalDialogOpen} onOpenChange={handleWithdrawalDialogOpenChange}>
          <DialogContent
            className={clsx("withdrawal-dialog", styles.withdrawalDialog)}
            data-step={withdrawalStep}
            data-with-back={withdrawalHeaderHasBack ? "true" : "false"}
            aria-busy={withdrawalRuntime.pendingAction === "status_refresh"}
            aria-label={withdrawalDialogTitle(withdrawalStep, t)}
          >
            {withdrawalToastMessage ? (
              <div className={styles.withdrawalToast} role="status">
                {withdrawalToastMessage}
              </div>
            ) : null}
            <div className={styles.withdrawalDialogHeader}>
              <div className={styles.withdrawalDialogHeaderLeft}>
                {withdrawalHeaderHasBack ? (
                  <button
                    className={styles.withdrawalDialogBack}
                    type="button"
                    aria-label={t("withdrawal.backAria")}
                    onClick={() => updateWithdrawalStep("overview")}
                  >
                    <ArrowLeft size={18} aria-hidden="true" />
                  </button>
                ) : null}
                <DialogTitle>{withdrawalDialogTitle(withdrawalStep, t)}</DialogTitle>
              </div>
              <div className={styles.withdrawalDialogHeaderRight}>
                {withdrawalStep === "records" ? (
                  <button
                    className={styles.withdrawalDialogToolButton}
                    type="button"
                    aria-label={t("withdrawal.refreshRecordsAria")}
                    title={t("withdrawal.refreshRecordsAria")}
                    disabled={withdrawalRecordsPage.syncing || withdrawalRecordsPage.loading}
                    onClick={refreshWithdrawalRecordsStatus}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {withdrawalRecordsPage.syncing ? t("withdrawal.refreshing") : t("withdrawal.refresh")}
                  </button>
                ) : null}
                <button
                  className={styles.withdrawalDialogClose}
                  type="button"
                  aria-label={t("withdrawal.closeAria")}
                  onClick={closeWithdrawalDialog}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </div>
            </div>
            <WithdrawalDialogContent
              onAuthExpired={handleWithdrawalAuthExpired}
              onRuntimePatch={(patch) => setWithdrawalRuntime((runtime) => ({ ...runtime, ...patch }))}
              onRecordsLoadMore={loadMoreWithdrawalRecords}
              onRecordsOpen={openWithdrawalRecords}
              onContractStateChange={handleWithdrawalContractStateChange}
              onStatusChange={handleWithdrawalStatusChange}
              onStepChange={updateWithdrawalStep}
              onToast={showWithdrawalToast}
              onWithdrawalSuccessComplete={completeWithdrawalSuccess}
              latestPayoutNotice={latestPayoutNotice}
              recordsPage={withdrawalRecordsPage}
              runtime={withdrawalRuntime}
              step={withdrawalStep}
              status={withdrawalStatus}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </aside>
  );
}

export function WithdrawalDialogContent(props: {
  onAuthExpired(): void;
  onRuntimePatch(patch: Partial<WithdrawalRuntimeState>): void;
  onRecordsLoadMore(): void;
  onRecordsOpen(): void;
  onContractStateChange(state: WithdrawalContractState): void;
  onStatusChange(status: WithdrawalStatusPlaceholder): void;
  onStepChange(step: WithdrawalStep): void;
  onToast(message: string): void;
  onWithdrawalSuccessComplete(): void;
  latestPayoutNotice: WithdrawalLatestPayoutNotice | null;
  recordsPage: WithdrawalRecordsPageState;
  runtime: WithdrawalRuntimeState;
  step: WithdrawalStep;
  status: WithdrawalStatusPlaceholder;
}) {
  const { language, t } = useI18n();
  const [identityForm, setIdentityForm] = useState<WithdrawalIdentityForm>(EMPTY_WITHDRAWAL_IDENTITY_FORM);
  const [stripeRecoveryOrderId, setStripeRecoveryOrderId] = useState("");
  const recordsLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const onRecordsLoadMoreRef = useRef(props.onRecordsLoadMore);
  const stripeSyncInFlightRef = useRef(false);
  const isStripeWithdrawal = props.status.settlement.provider === "stripe";
  const minimumWithdrawalCents = isStripeWithdrawal ? 1 : WITHDRAWAL_MIN_CENTS;
  const canWithdraw = props.status.balanceCents >= minimumWithdrawalCents && !props.status.payoutInProgress;
  const canOpenStripeProgress = isStripeWithdrawal && props.status.payoutInProgress;
  const contractNeedsSigning = props.status.contractStatus !== "signed";
  const contractSigningActive = props.status.contractStatus === "signing";
  const contractSigningFailed = props.status.contractStatus === "failed";
  const profileVerificationPending =
    props.runtime.pendingAction === "identity_submit" || isWithdrawalProfilePending(props.status);
  const bankCardLabel = props.status.bankCardLast4
    ? isStripeWithdrawal
      ? t("withdrawal.stripeBankLast4", {
          bank: props.status.stripeConnect?.account?.externalAccountBankName || "Stripe",
          last4: props.status.bankCardLast4,
        })
      : t("withdrawal.bankCardLast4", { last4: props.status.bankCardLast4 })
    : isStripeWithdrawal
      ? t("withdrawal.stripeBankPending")
      : t("withdrawal.bankCardPending");
  const signingUrl = props.runtime.signingUrl || props.status.signingUrl;
  const contractHasSigningUrl = !contractSigningFailed && Boolean(signingUrl);
  const contractLinkBlocked = !contractSigningFailed && !contractHasSigningUrl;
  const contractFallbackMessage = props.runtime.error || t("withdrawal.contractLinkUnavailable");
  const showWithdrawalOverview = props.step === "overview";
  const canViewWithdrawalRecords = props.status.withdrawalCount > 0 || props.status.recordsStatus === "unavailable";
  const visibleWithdrawalRecords = props.recordsPage.records;
  const withdrawalRecordsTotal = props.recordsPage.total || props.status.withdrawalCount;
  const withdrawalRecordsHasMore = !props.recordsPage.error && visibleWithdrawalRecords.length < withdrawalRecordsTotal;
  const withdrawalDisabledTooltip = props.status.payoutInProgress
    ? t("withdrawal.payoutInProgress")
    : isStripeWithdrawal
      ? t("withdrawal.disabledTooltipUsd")
      : t("withdrawal.disabledTooltip");
  const identityFormError =
    props.step === "identity" ? props.runtime.error || withdrawalProfileStatusMessage(props.status, t) : "";

  useEffect(() => {
    onRecordsLoadMoreRef.current = props.onRecordsLoadMore;
  }, [props.onRecordsLoadMore]);

  useEffect(() => {
    if (props.step !== "records") return;
    if (!withdrawalRecordsHasMore || props.recordsPage.loading || props.recordsPage.loadingMore) return;
    const node = recordsLoadSentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onRecordsLoadMoreRef.current();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    props.step,
    props.recordsPage.loading,
    props.recordsPage.loadingMore,
    visibleWithdrawalRecords.length,
    withdrawalRecordsHasMore,
  ]);

  useEffect(() => {
    if (props.step !== "contract" || props.status.contractStatus !== "signing") return;
    const startedAt = Date.now();
    const intervalId = window.setInterval(() => {
      if (Date.now() - startedAt >= WITHDRAWAL_CONTRACT_POLL_MAX_MS) {
        window.clearInterval(intervalId);
        props.onRuntimePatch({ error: t("withdrawal.contractAutoSyncPaused") });
        return;
      }
      void pollH5SignStatus(false).catch((error) => {
        if (isWithdrawalAuthExpiredError(error)) {
          props.onAuthExpired();
          return;
        }
        console.error("[opengrove-ui] h5 sign status poll failed", error);
      });
    }, WITHDRAWAL_CONTRACT_POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [props.step, props.status.contractStatus]);

  useEffect(() => {
    const pendingPageId = window.sessionStorage.getItem(STRIPE_ONBOARDING_PENDING_KEY) ?? "";
    if (!isStripeWithdrawal || props.runtime.pendingAction || !pendingPageId) return;
    let active = true;
    const syncAfterReturn = () => {
      if (!active || document.visibilityState === "hidden") return;
      void syncStripeAfterOnboarding();
    };
    window.addEventListener("focus", syncAfterReturn);
    document.addEventListener("visibilitychange", syncAfterReturn);
    if (shouldSyncStripeOnboardingOnMount(pendingPageId)) syncAfterReturn();
    return () => {
      active = false;
      window.removeEventListener("focus", syncAfterReturn);
      document.removeEventListener("visibilitychange", syncAfterReturn);
    };
  }, [isStripeWithdrawal, props.runtime.pendingAction]);

  useEffect(() => {
    const activePayout = props.status.activePayout;
    if (props.step !== "stripe_progress" || !activePayout || activePayout.provider !== "stripe") return;
    const recoveryPolling = stripeRecoveryOrderId === activePayout.orderId;
    if (stripeOrderPollingComplete(activePayout.status, activePayout.providerStatus) && !recoveryPolling) return;
    const startedAt = Date.now();
    let cancelled = false;
    let timeoutId = 0;
    const poll = async () => {
      try {
        const record = await readPayoutOrder(activePayout.orderId);
        if (cancelled) return;
        applyStripeOrderRecord(record);
        const stillWaitingForRecovery =
          recoveryPolling &&
          record.providerStatus === "payout_action_required" &&
          record.actionRequired === "update_bank_account";
        if (!stillWaitingForRecovery && stripeOrderPollingComplete(record.status, record.providerStatus)) {
          setStripeRecoveryOrderId("");
          return;
        }
      } catch (error) {
        if (!cancelled && isWithdrawalAuthExpiredError(error)) props.onAuthExpired();
      }
      if (cancelled) return;
      timeoutId = window.setTimeout(poll, Date.now() - startedAt < 30_000 ? 3_000 : 10_000);
    };
    timeoutId = window.setTimeout(poll, 3_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [props.step, props.status.activePayout?.orderId, stripeRecoveryOrderId]);

  async function startWithdrawalFlow() {
    if (props.runtime.pendingAction) return;
    let latestStatus = props.status;
    props.onRuntimePatch({ error: "", pendingAction: "status_refresh" });
    try {
      latestStatus = await readWithdrawalStatus();
      props.onStatusChange(latestStatus);
    } catch (error) {
      if (isWithdrawalAuthExpiredError(error)) {
        props.onAuthExpired();
        return;
      }
      props.onRuntimePatch({ error: apiErrorMessage(t) });
      return;
    } finally {
      props.onRuntimePatch({ pendingAction: null });
    }

    if (latestStatus.settlement.provider === "stripe") {
      routeStripeWithdrawalStatus(latestStatus);
      return;
    }
    if (latestStatus.payoutInProgress) {
      props.onStepChange("overview");
      props.onRuntimePatch({ error: t("withdrawal.payoutInProgress") });
      return;
    }
    if (latestStatus.balanceCents < WITHDRAWAL_MIN_CENTS) {
      props.onStepChange("overview");
      props.onRuntimePatch({ error: t("withdrawal.noBalance") });
      return;
    }
    if (!isWithdrawalProfileVerified(latestStatus)) {
      props.onRuntimePatch({ error: "" });
      props.onStepChange("identity");
      return;
    }
    if (latestStatus.contractStatus !== "signed") {
      if (latestStatus.contractStatus === "signing" && (latestStatus.signingUrl || props.runtime.signingUrl)) {
        props.onRuntimePatch({ signingUrl: latestStatus.signingUrl || props.runtime.signingUrl, error: "" });
        props.onStepChange("contract");
        return;
      }
      if (latestStatus.contractStatus === "failed") {
        props.onRuntimePatch({ error: "" });
        props.onStepChange("contract");
        return;
      }
      await requestH5SignApplication(latestStatus);
      return;
    }
    props.onRuntimePatch({ error: "" });
    props.onStepChange("confirm");
  }

  function routeStripeWithdrawalStatus(status: WithdrawalStatusPlaceholder): void {
    const connect = status.stripeConnect;
    props.onRuntimePatch({ error: "" });
    if (status.activePayout?.provider === "stripe") {
      props.onStepChange("stripe_progress");
      return;
    }
    if (status.payoutInProgress) {
      props.onRuntimePatch({ error: t("withdrawal.stripeActiveOrderUnavailable") });
      props.onStepChange("stripe_unavailable");
      return;
    }
    if (!connect) {
      props.onStepChange("stripe_unavailable");
      return;
    }
    if (!connect.consentAccepted) {
      props.onStepChange("stripe_consent");
      return;
    }
    if (connect.readyForPayout) {
      if (status.balanceCents < 1) {
        props.onStepChange("overview");
        props.onRuntimePatch({ error: t("withdrawal.noBalance") });
        return;
      }
      props.onStepChange("confirm");
      return;
    }
    if (connect.missingRequirements.includes("account_verification_pending")) {
      props.onStepChange("stripe_review");
      return;
    }
    if (
      connect.missingRequirements.some((requirement) =>
        ["connected_account", "account_requirements", "usd_bank_account"].includes(requirement),
      )
    ) {
      props.onStepChange("stripe_setup");
      return;
    }
    props.onStepChange("stripe_unavailable");
  }

  async function openStripeOnboarding(): Promise<void> {
    if (props.runtime.pendingAction) return;
    props.onRuntimePatch({ error: "", pendingAction: "stripe_onboarding" });
    try {
      const response = await createStripeOnboardingLink();
      assertWithdrawalApiOk(response);
      const url = extractStripeHostedOnboardingUrl(response);
      if (!url) throw new Error("stripe_onboarding_url_invalid");
      window.sessionStorage.setItem(STRIPE_ONBOARDING_PENDING_KEY, STRIPE_ONBOARDING_PAGE_ID);
      window.location.assign(url);
    } catch (error) {
      if (isWithdrawalAuthExpiredError(error)) {
        props.onAuthExpired();
        return;
      }
      props.onRuntimePatch({ error: translatedWithdrawalPayoutError(error, t) || apiErrorMessage(t) });
    } finally {
      props.onRuntimePatch({ pendingAction: null });
    }
  }

  async function syncStripeAfterOnboarding(): Promise<void> {
    if (props.runtime.pendingAction || stripeSyncInFlightRef.current) return;
    stripeSyncInFlightRef.current = true;
    window.sessionStorage.removeItem(STRIPE_ONBOARDING_PENDING_KEY);
    props.onRuntimePatch({ error: "", pendingAction: "stripe_sync" });
    try {
      await syncStripeConnectStatus();
      let nextStatus = await readWithdrawalStatus();
      const recoveryOrder = nextStatus.activePayout;
      if (recoveryOrder?.provider === "stripe" && recoveryOrder.actionRequired === "update_bank_account") {
        await syncPayoutOrder(recoveryOrder.orderId);
        setStripeRecoveryOrderId(recoveryOrder.orderId);
        const record = await readPayoutOrder(recoveryOrder.orderId);
        applyStripeOrderRecord(record, nextStatus);
        nextStatus = { ...nextStatus, activePayout: withdrawalActivePayoutFromRecord(record) };
      }
      props.onStatusChange(nextStatus);
      routeStripeWithdrawalStatus(nextStatus);
    } catch (error) {
      if (isWithdrawalAuthExpiredError(error)) {
        props.onAuthExpired();
        return;
      }
      props.onRuntimePatch({ error: translatedWithdrawalPayoutError(error, t) || apiErrorMessage(t) });
    } finally {
      stripeSyncInFlightRef.current = false;
      props.onRuntimePatch({ pendingAction: null });
    }
  }

  function applyStripeOrderRecord(
    record: WithdrawalRecord,
    baseStatus: WithdrawalStatusPlaceholder = props.status,
  ): void {
    if (record.provider !== "stripe") return;
    if (record.status === "paid" || record.providerStatus === "paid") {
      void readWithdrawalStatus()
        .then((nextStatus) => {
          props.onStatusChange(nextStatus);
          props.onStepChange("success");
        })
        .catch(() => {
          props.onStepChange("success");
        });
      return;
    }
    props.onStatusChange({
      ...baseStatus,
      activePayout: withdrawalActivePayoutFromRecord(record),
      payoutInProgress: isWithdrawalRecordInProgress(record),
      withdrawalRecords: [record, ...baseStatus.withdrawalRecords.filter((item) => item.id !== record.id)],
    });
    props.onStepChange("stripe_progress");
  }

  async function refreshStripeOrder(): Promise<void> {
    const activePayout = props.status.activePayout;
    if (!activePayout || props.runtime.pendingAction) return;
    props.onRuntimePatch({ error: "", pendingAction: "stripe_order_sync" });
    try {
      await syncPayoutOrder(activePayout.orderId);
      const record = await readPayoutOrder(activePayout.orderId);
      applyStripeOrderRecord(record);
    } catch (error) {
      if (isWithdrawalAuthExpiredError(error)) {
        props.onAuthExpired();
        return;
      }
      props.onRuntimePatch({ error: translatedWithdrawalSyncError(error, t) || apiErrorMessage(t) });
    } finally {
      props.onRuntimePatch({ pendingAction: null });
    }
  }

  async function submitIdentityForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (profileVerificationPending) return;
    const nextErrors = validateWithdrawalIdentityForm(identityForm, t);
    if (Object.keys(nextErrors).length > 0) {
      props.onRuntimePatch({ error: t("withdrawal.identityInvalid") });
      return;
    }

    props.onRuntimePatch({ error: "", pendingAction: "identity_submit" });
    try {
      const verificationResponse = await createPayoutProfileVerification({
        real_name: identityForm.realName.trim(),
        id_card: identityForm.idCard.trim().toUpperCase(),
        bank_card_no: onlyDigits(identityForm.cardNo),
        phone_no: onlyDigits(identityForm.phoneNo),
      });
      const publicErrorMessage = translatedWithdrawalProfileError(verificationResponse, t);
      if (publicErrorMessage) {
        applyIdentityVerificationRejected(publicErrorMessage);
        return;
      }
      const identityFailure = extractWithdrawalVerificationFailure(verificationResponse, "identity");
      if (identityFailure) {
        applyIdentityVerificationRejected(withdrawalVerificationFailureProductMessage(identityFailure, "identity", t));
        return;
      }

      const bankCardFailure = extractWithdrawalVerificationFailure(verificationResponse, "bank_card");
      if (bankCardFailure) {
        applyIdentityVerificationRejected(withdrawalVerificationFailureProductMessage(bankCardFailure, "bank_card", t));
        return;
      }
      const nextStatus = await readWithdrawalStatus();
      props.onStatusChange(nextStatus);
      if (!applyIdentityVerificationStatus(nextStatus, {})) {
        props.onRuntimePatch({ error: t("withdrawal.identityVerificationFailed") });
      }
    } catch (error) {
      if (isWithdrawalAuthExpiredError(error)) {
        props.onAuthExpired();
        return;
      }
      const submissionErrorMessage = translatedWithdrawalProfileError(error, t);
      if (submissionErrorMessage) {
        applyIdentityVerificationRejected(submissionErrorMessage);
        return;
      }
      const latestStatus = await refreshWithdrawalStatusFromServer();
      if (latestStatus && applyIdentityVerificationStatus(latestStatus, {})) return;
      applyIdentityVerificationRejected(
        error instanceof Error && error.message === "withdrawal_api_failed"
          ? t("withdrawal.retryLater")
          : apiErrorMessage(t),
      );
    } finally {
      props.onRuntimePatch({ pendingAction: null });
    }
  }

  function applyIdentityVerificationStatus(
    status: WithdrawalStatusPlaceholder,
    responseFieldErrors: WithdrawalProfileFieldErrors,
  ): boolean {
    const fieldErrors = mergeWithdrawalProfileFieldErrors(status.profileFieldErrors, responseFieldErrors);
    if (isWithdrawalProfilePending(status)) {
      props.onRuntimePatch({ error: "" });
      props.onStepChange("identity");
      return true;
    }
    if (isWithdrawalProfileRejected(status) || hasWithdrawalProfileFieldErrors(fieldErrors)) {
      applyIdentityVerificationRejected(
        withdrawalProfileStatusMessage({ ...status, profileFieldErrors: fieldErrors }, t),
      );
      return true;
    }
    if (isWithdrawalProfileVerified(status)) {
      props.onRuntimePatch({ error: "" });
      props.onStepChange("identity_success");
      return true;
    }
    props.onStepChange("identity");
    return false;
  }

  function applyIdentityVerificationRejected(message = t("withdrawal.retryLater")): void {
    props.onRuntimePatch({ error: message });
    props.onStepChange("identity");
  }

  function updateIdentityFormField(field: keyof WithdrawalIdentityForm, value: string): void {
    setIdentityForm((form) => ({ ...form, [field]: value }));
    if (props.runtime.error) props.onRuntimePatch({ error: "" });
  }

  async function requestH5SignApplication(baseStatus: WithdrawalStatusPlaceholder = props.status) {
    props.onRuntimePatch({ error: "", pendingAction: "h5_sign_application" });
    try {
      const response = await createH5SignApplication();
      const responseErrorMessage = translatedWithdrawalSignError(response, t);
      if (responseErrorMessage) {
        const latestStatus = await refreshWithdrawalStatusFromServer();
        const resumedSigningUrl = latestStatus?.contractStatus === "signing" ? latestStatus.signingUrl : "";
        props.onRuntimePatch({ signingUrl: resumedSigningUrl, error: resumedSigningUrl ? "" : responseErrorMessage });
        props.onStepChange("contract");
        return;
      }
      assertWithdrawalApiOk(response);
      const applicationStatus = extractPaymentStatus(response).trim().toLowerCase();
      if (extractPaymentSigned(response) || applicationStatus === "signed") {
        const nextStatus = await readWithdrawalStatus();
        props.onStatusChange(nextStatus);
        props.onRuntimePatch({ signingUrl: "", error: "" });
        props.onStepChange("confirm");
        return;
      }
      if (applicationStatus === "failed") {
        props.onStatusChange({
          ...baseStatus,
          contractStatus: "failed",
          signingUrl: "",
        });
        props.onRuntimePatch({ signingUrl: "", error: "" });
        props.onStepChange("contract");
        return;
      }
      const nextSigningUrl = extractPaymentUrl(response);
      props.onStatusChange({
        ...baseStatus,
        contractStatus: "signing",
        signingUrl: nextSigningUrl,
      });
      props.onRuntimePatch({ signingUrl: nextSigningUrl, error: "" });
      props.onStepChange("contract");
    } catch (error) {
      if (isWithdrawalAuthExpiredError(error)) {
        props.onAuthExpired();
        return;
      }
      const signingErrorMessage = translatedWithdrawalSignError(error, t) || apiErrorMessage(t);
      const latestStatus = await refreshWithdrawalStatusFromServer();
      const resumedSigningUrl = latestStatus?.contractStatus === "signing" ? latestStatus.signingUrl : "";
      props.onRuntimePatch({ signingUrl: resumedSigningUrl, error: resumedSigningUrl ? "" : signingErrorMessage });
      props.onStepChange("contract");
    } finally {
      props.onRuntimePatch({ pendingAction: null });
    }
  }

  function continueContractSigning(): void {
    if (contractSigningActive && signingUrl) {
      props.onRuntimePatch({ error: "" });
      props.onStepChange("contract");
      return;
    }
    void requestH5SignApplication();
  }

  function openSigningUrlInBrowser(): void {
    if (!signingUrl) return;
    window.open(signingUrl, "_blank", "noopener,noreferrer");
  }

  async function syncH5SignStatus() {
    props.onRuntimePatch({ error: "", pendingAction: "h5_sign_status" });
    try {
      await pollH5SignStatus(true);
    } catch (error) {
      if (isWithdrawalAuthExpiredError(error)) {
        props.onAuthExpired();
        return;
      }
      props.onRuntimePatch({ error: apiErrorMessage(t) });
    } finally {
      props.onRuntimePatch({ pendingAction: null });
    }
  }

  async function pollH5SignStatus(showPendingMessage: boolean): Promise<void> {
    const nextState = await readWithdrawalContractState();
    if (nextState.contractStatus === "signed") {
      props.onContractStateChange(nextState);
      props.onRuntimePatch({ signingUrl: "", error: "" });
      props.onStepChange("confirm");
      return;
    }
    if (nextState.contractStatus === "failed") {
      props.onContractStateChange(nextState);
      props.onRuntimePatch({ signingUrl: "", error: "" });
      props.onStepChange("contract");
      return;
    }
    if (nextState.contractStatus === "signing") {
      props.onContractStateChange(nextState);
      props.onRuntimePatch({
        signingUrl: nextState.signingUrl || props.runtime.signingUrl,
        error: showPendingMessage ? t("withdrawal.contractPending") : props.runtime.error,
      });
      props.onStepChange("contract");
      return;
    }
    if (props.step === "contract" && props.status.contractStatus === "signing") {
      const resumedState: WithdrawalContractState = {
        contractStatus: "signing",
        signingUrl: nextState.signingUrl || props.status.signingUrl || props.runtime.signingUrl,
      };
      props.onContractStateChange(resumedState);
      props.onRuntimePatch({
        signingUrl: resumedState.signingUrl,
        error: showPendingMessage ? t("withdrawal.contractPending") : props.runtime.error,
      });
      return;
    }
    props.onContractStateChange(nextState);
    if (showPendingMessage) {
      props.onRuntimePatch({ error: t("withdrawal.contractSyncFailed") });
    }
  }

  async function refreshWithdrawalStatusFromServer(): Promise<WithdrawalStatus | null> {
    try {
      const nextStatus = await readWithdrawalStatus();
      props.onStatusChange(nextStatus);
      return nextStatus;
    } catch (error) {
      if (isWithdrawalAuthExpiredError(error)) {
        props.onAuthExpired();
        return null;
      }
      console.error("[opengrove-ui] withdrawal status refresh failed", error);
      return null;
    }
  }

  async function submitWithdrawal() {
    if (!isStripeWithdrawal && props.status.balanceCents < minimumWithdrawalCents) return;

    props.onRuntimePatch({ error: "", pendingAction: "payout_order" });

    try {
      if (isStripeWithdrawal) {
        const latestStatus = await readWithdrawalStatus();
        props.onStatusChange(latestStatus);
        const latestConnect = latestStatus.stripeConnect;
        const readyToCreate =
          latestStatus.settlement.provider === "stripe" &&
          latestConnect?.consentAccepted === true &&
          latestConnect.readyForPayout &&
          latestStatus.balanceCents >= 1 &&
          !latestStatus.payoutInProgress;
        if (!readyToCreate) {
          if (latestStatus.settlement.provider === "stripe") {
            routeStripeWithdrawalStatus(latestStatus);
          } else {
            props.onStepChange("overview");
            props.onRuntimePatch({ error: t("withdrawal.apiRequestFailed") });
          }
          return;
        }
      }
      const response = await createPayoutOrder();
      assertWithdrawalApiOk(response);
      const payoutStatus = extractPaymentStatus(response);
      if (isWithdrawalPayoutFailedStatus(payoutStatus)) throw new Error("withdrawal_payout_failed");
      const orderId = extractPayoutOrderId(response);
      if (!orderId) throw new Error("withdrawal_order_id_missing");
      if (isStripeWithdrawal) {
        const [record, nextStatus] = await Promise.all([readPayoutOrder(orderId), readWithdrawalStatus()]);
        applyStripeOrderRecord(record, nextStatus);
        props.onRuntimePatch({ error: "" });
        return;
      }
      await refreshWithdrawalStatusFromServer();
      props.onRuntimePatch({ error: "" });
      props.onStepChange("success");
    } catch (error) {
      const publicErrorName = extractWithdrawalPublicErrorName(error);
      if (isWithdrawalAuthExpiredError(error)) {
        props.onAuthExpired();
        return;
      }
      if (publicErrorName === "PAYOUT_PROFILE_REQUIRED") {
        await refreshWithdrawalStatusFromServer();
        props.onRuntimePatch({ error: translatedWithdrawalPayoutError(error, t) });
        props.onStepChange("identity");
        return;
      }
      if (publicErrorName === "SIGN_REQUIRED") {
        await refreshWithdrawalStatusFromServer();
        props.onRuntimePatch({ error: translatedWithdrawalPayoutError(error, t) });
        props.onStepChange("contract");
        return;
      }
      if (publicErrorName === "NO_WITHDRAWABLE_BALANCE") {
        await refreshWithdrawalStatusFromServer();
        props.onStepChange("overview");
        props.onRuntimePatch({ error: translatedWithdrawalPayoutError(error, t) });
        return;
      }
      if (publicErrorName === "PAYOUT_REQUEST_IN_PROGRESS") {
        const recovered = await recoverActivePayoutAfterSubmitError();
        if (recovered) return;
      }
      if (publicErrorName === "STRIPE_CONSENT_REQUIRED" || publicErrorName === "STRIPE_CONNECT_NOT_READY") {
        const nextStatus = await refreshWithdrawalStatusFromServer();
        if (nextStatus?.settlement.provider === "stripe") routeStripeWithdrawalStatus(nextStatus);
        props.onRuntimePatch({ error: translatedWithdrawalPayoutError(error, t) });
        return;
      }
      if (publicErrorName === "PAYOUT_DAILY_LIMIT_EXCEEDED" || publicErrorName === "PAYOUT_AMOUNT_LIMIT_EXCEEDED") {
        props.onStepChange("overview");
        props.onRuntimePatch({ error: translatedWithdrawalPayoutError(error, t) });
        return;
      }
      if (publicErrorName === "STRIPE_UNAVAILABLE") {
        props.onStepChange("stripe_unavailable");
        props.onRuntimePatch({ error: translatedWithdrawalPayoutError(error, t) });
        return;
      }
      if (publicErrorName === "SERVICE_UNAVAILABLE") {
        const recovered = await recoverActivePayoutAfterSubmitError();
        if (recovered) return;
        await refreshWithdrawalStatusFromServer();
        props.onRuntimePatch({ error: "" });
        props.onToast(translatedWithdrawalPayoutError(error, t));
        return;
      }
      const recovered = await recoverActivePayoutAfterSubmitError();
      if (recovered) return;
      await refreshWithdrawalStatusFromServer();
      props.onRuntimePatch({ error: translatedWithdrawalPayoutError(error, t) || apiErrorMessage(t) });
    } finally {
      props.onRuntimePatch({ pendingAction: null });
    }
  }

  async function recoverActivePayoutAfterSubmitError(): Promise<boolean> {
    try {
      const nextStatus = await readWithdrawalStatus();
      props.onStatusChange(nextStatus);
      if (!nextStatus.activePayout) return false;
      props.onRuntimePatch({ error: "" });
      props.onStepChange(nextStatus.activePayout.provider === "stripe" ? "stripe_progress" : "success");
      return true;
    } catch {
      return false;
    }
  }

  return (
    <div className={styles.withdrawalShell}>
      {showWithdrawalOverview ? (
        <div className={styles.withdrawalOverviewMetrics}>
          <section className={styles.withdrawalSummary} aria-label={t("withdrawal.overviewAria")}>
            <div className={styles.withdrawalSummaryIcon} aria-hidden="true">
              <WalletCards size={22} />
            </div>
            <div className={styles.withdrawalBalance}>
              <span>{t("withdrawal.currentBalance")}</span>
              <strong>
                {formatWithdrawalAmount(props.status.balanceCents, props.status.settlement.currency, language, t)}
              </strong>
            </div>
            <span
              className={styles.withdrawalSummaryActionWrap}
              data-tooltip={!canWithdraw && !canOpenStripeProgress ? withdrawalDisabledTooltip : undefined}
            >
              <button
                className={styles.withdrawalSummaryAction}
                type="button"
                disabled={(!canWithdraw && !canOpenStripeProgress) || Boolean(props.runtime.pendingAction)}
                onClick={() => void startWithdrawalFlow()}
              >
                {props.runtime.pendingAction === "status_refresh"
                  ? t("withdrawal.checking")
                  : canOpenStripeProgress
                    ? t("withdrawal.stripeViewProgress")
                    : t("withdrawal.withdrawAll")}
              </button>
            </span>
          </section>
          <div className={styles.withdrawalStats} aria-label={t("withdrawal.statsAria")}>
            <WithdrawalStat
              icon={Coins}
              label={t("withdrawal.totalEarnings")}
              value={formatWithdrawalAmount(
                props.status.totalEarningsCents,
                props.status.settlement.currency,
                language,
                t,
              )}
            />
            {canViewWithdrawalRecords ? (
              <button
                className={clsx(styles.withdrawalStat, styles.withdrawalRecordStat)}
                type="button"
                aria-label={t("withdrawal.viewRecordsAria", { count: props.status.withdrawalCount })}
                onClick={props.onRecordsOpen}
              >
                <CreditCard size={17} aria-hidden="true" />
                <span>{t("withdrawal.titleRecords")}</span>
                <strong>
                  {props.status.recordsStatus === "unavailable"
                    ? t("withdrawal.recordsUnavailable")
                    : t("withdrawal.countTimes", { count: props.status.withdrawalCount })}
                </strong>
                <span className={styles.withdrawalRecordLink}>{t("withdrawal.viewRecords")}</span>
              </button>
            ) : (
              <div
                className={clsx(styles.withdrawalStat, styles.withdrawalRecordStat)}
                aria-label={t("withdrawal.titleRecords")}
              >
                <CreditCard size={17} aria-hidden="true" />
                <span>{t("withdrawal.titleRecords")}</span>
                <strong>
                  {props.status.recordsStatus === "unavailable"
                    ? t("withdrawal.recordsUnavailable")
                    : t("withdrawal.countTimes", { count: props.status.withdrawalCount })}
                </strong>
              </div>
            )}
          </div>
          {props.latestPayoutNotice ? (
            <p className={styles.withdrawalLatestStatus}>
              <Activity size={14} aria-hidden="true" />
              <span>
                {t("withdrawal.latestProcessingWithRecords", {
                  amount: formatWithdrawalAmount(
                    props.latestPayoutNotice.amountCents,
                    props.latestPayoutNotice.currency,
                    language,
                    t,
                  ),
                })}
              </span>
            </p>
          ) : null}
          {props.runtime.error ? <p className={styles.withdrawalError}>{props.runtime.error}</p> : null}
        </div>
      ) : null}

      {props.step === "stripe_consent" ? (
        <section className={styles.withdrawalContract} aria-label={t("withdrawal.stripeConsentTitle")}>
          <div className={styles.withdrawalContractCopy}>
            <h3>{t("withdrawal.stripeConsentHeading")}</h3>
            <p>{t("withdrawal.stripeConsentCopy")}</p>
            {props.runtime.error ? <p className={styles.withdrawalError}>{props.runtime.error}</p> : null}
          </div>
          <div className={clsx("modal-actions", styles.withdrawalContractActions)}>
            <button
              className="primary-button"
              type="button"
              disabled={Boolean(props.runtime.pendingAction)}
              onClick={() => void startWithdrawalFlow()}
            >
              {props.runtime.pendingAction === "status_refresh"
                ? t("withdrawal.checking")
                : t("withdrawal.stripeConsentCheckStatus")}
            </button>
          </div>
        </section>
      ) : null}

      {props.step === "stripe_setup" ? (
        <section className={styles.withdrawalContract} aria-label={t("withdrawal.stripeSetupTitle")}>
          <div className={styles.withdrawalContractCopy}>
            <h3>{t("withdrawal.stripeSetupHeading")}</h3>
            <p>{t("withdrawal.stripeSetupCopy")}</p>
            <p>{t("withdrawal.stripeHostedSafety")}</p>
            {props.runtime.error ? <p className={styles.withdrawalError}>{props.runtime.error}</p> : null}
          </div>
          <div className={clsx("modal-actions", styles.withdrawalContractActions)}>
            <button
              className="primary-button"
              type="button"
              disabled={Boolean(props.runtime.pendingAction)}
              onClick={() => void openStripeOnboarding()}
            >
              {props.runtime.pendingAction === "stripe_onboarding"
                ? t("withdrawal.applying")
                : t("withdrawal.stripeContinue")}
            </button>
            <button
              className="ghost-button"
              type="button"
              disabled={Boolean(props.runtime.pendingAction)}
              onClick={() => void syncStripeAfterOnboarding()}
            >
              {props.runtime.pendingAction === "stripe_sync"
                ? t("withdrawal.syncing")
                : t("withdrawal.stripeCompleted")}
            </button>
          </div>
        </section>
      ) : null}

      {props.step === "stripe_review" ? (
        <section className={styles.withdrawalSuccess} aria-label={t("withdrawal.stripeReviewTitle")}>
          <Activity size={44} aria-hidden="true" />
          <h3>{t("withdrawal.stripeReviewHeading")}</h3>
          <p>{t("withdrawal.stripeReviewCopy")}</p>
          <button
            className="primary-button"
            type="button"
            disabled={Boolean(props.runtime.pendingAction)}
            onClick={() => void startWithdrawalFlow()}
          >
            {props.runtime.pendingAction === "status_refresh"
              ? t("withdrawal.checking")
              : t("withdrawal.stripeCheckStatus")}
          </button>
          {props.runtime.error ? <p className={styles.withdrawalError}>{props.runtime.error}</p> : null}
        </section>
      ) : null}

      {props.step === "stripe_unavailable" ? (
        <section className={styles.withdrawalSuccess} aria-label={t("withdrawal.stripeUnavailableTitle")}>
          <HelpCircle size={44} aria-hidden="true" />
          <h3>{t("withdrawal.stripeUnavailableHeading")}</h3>
          <p>{props.runtime.error || t("withdrawal.stripeUnavailableCopy")}</p>
          <button className="ghost-button" type="button" onClick={() => void startWithdrawalFlow()}>
            {t("withdrawal.retry")}
          </button>
        </section>
      ) : null}

      {props.step === "stripe_progress" ? (
        <section className={styles.withdrawalConfirm} aria-label={t("withdrawal.stripeProgressTitle")}>
          <div className={styles.withdrawalActionBody}>
            <div className={styles.withdrawalConfirmAmount}>
              <span>{t("withdrawal.thisWithdrawal")}</span>
              <strong>
                {formatWithdrawalAmount(
                  props.status.activePayout?.amountCents ?? props.status.frozenCents,
                  props.status.activePayout?.currency ?? "USD",
                  language,
                  t,
                )}
              </strong>
            </div>
            <div className={styles.withdrawalConfirmRows}>
              <div>
                <span>{t("withdrawal.recordStatus")}</span>
                <strong>{stripeActivePayoutStatusLabel(props.status.activePayout, t)}</strong>
              </div>
            </div>
            <p>
              {props.status.activePayout?.actionRequired === "update_bank_account"
                ? t("withdrawal.stripeUpdateBankCopy")
                : props.status.activePayout?.providerStatus === "review_required"
                  ? t("withdrawal.stripeOrderReviewCopy")
                  : t("withdrawal.stripeProgressCopy")}
            </p>
            {props.runtime.error ? <p className={styles.withdrawalError}>{props.runtime.error}</p> : null}
          </div>
          <div className="modal-actions">
            {props.status.activePayout?.actionRequired === "update_bank_account" ? (
              <button
                className="primary-button"
                type="button"
                disabled={Boolean(props.runtime.pendingAction)}
                onClick={() => void openStripeOnboarding()}
              >
                {props.runtime.pendingAction === "stripe_onboarding"
                  ? t("withdrawal.applying")
                  : t("withdrawal.stripeUpdateBank")}
              </button>
            ) : null}
            <button
              className="ghost-button"
              type="button"
              disabled={Boolean(props.runtime.pendingAction)}
              onClick={() => void refreshStripeOrder()}
            >
              {props.runtime.pendingAction === "stripe_order_sync"
                ? t("withdrawal.refreshing")
                : t("withdrawal.refresh")}
            </button>
          </div>
        </section>
      ) : null}

      {props.step === "identity" ? (
        <form
          className={styles.withdrawalForm}
          aria-label={t("withdrawal.identityFormAria")}
          aria-busy={profileVerificationPending}
          onSubmit={(event) => void submitIdentityForm(event)}
        >
          <div className={styles.withdrawalActionBody}>
            <div className={styles.withdrawalFormGrid}>
              <WithdrawalField
                autoComplete="name"
                disabled={profileVerificationPending}
                label={t("withdrawal.realName")}
                placeholder={t("withdrawal.fieldPlaceholder")}
                value={identityForm.realName}
                onChange={(realName) => updateIdentityFormField("realName", realName)}
              />
              <WithdrawalField
                autoComplete="off"
                disabled={profileVerificationPending}
                label={t("withdrawal.idCard")}
                placeholder={t("withdrawal.fieldPlaceholder")}
                value={identityForm.idCard}
                onChange={(idCard) => updateIdentityFormField("idCard", normalizeIdCardInput(idCard))}
              />
              <WithdrawalField
                autoComplete="tel"
                disabled={profileVerificationPending}
                inputMode="numeric"
                label={t("withdrawal.phoneNo")}
                placeholder={t("withdrawal.fieldPlaceholder")}
                value={identityForm.phoneNo}
                onChange={(phoneNo) => updateIdentityFormField("phoneNo", onlyDigits(phoneNo).slice(0, 11))}
              />
              <WithdrawalField
                autoComplete="cc-number"
                disabled={profileVerificationPending}
                inputMode="numeric"
                label={t("withdrawal.bankCard")}
                placeholder={t("withdrawal.fieldPlaceholder")}
                value={identityForm.cardNo}
                onChange={(cardNo) => updateIdentityFormField("cardNo", onlyDigits(cardNo).slice(0, 19))}
              />
            </div>
            <p className={styles.withdrawalTip}>{t("withdrawal.identityTip")}</p>
          </div>
          <div className={styles.withdrawalFormFooter}>
            <p className={styles.withdrawalFormErrorSlot} aria-live="polite">
              {identityFormError}
            </p>
            <div className={styles.withdrawalFormActions}>
              <button className="primary-button" type="submit" disabled={profileVerificationPending}>
                {profileVerificationPending ? t("withdrawal.verifying") : t("withdrawal.submit")}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      {props.step === "identity_success" ? (
        <section className={styles.withdrawalSuccess} aria-label={t("withdrawal.identityResultAria")}>
          <BadgeCheck size={44} aria-hidden="true" />
          <h3>{t("withdrawal.identitySuccessHeading")}</h3>
          {contractNeedsSigning ? (
            <>
              <p>{t("withdrawal.identityLastStep")}</p>
              <button
                className="primary-button"
                type="button"
                disabled={props.runtime.pendingAction === "h5_sign_application"}
                onClick={continueContractSigning}
              >
                {props.runtime.pendingAction === "h5_sign_application"
                  ? t("withdrawal.applying")
                  : contractSigningActive
                    ? t("withdrawal.resumeSigning")
                    : t("withdrawal.enterSigning")}
              </button>
            </>
          ) : (
            <>
              <p>{t("withdrawal.identityComplete")}</p>
              <button className="primary-button" type="button" onClick={() => props.onStepChange("confirm")}>
                {t("withdrawal.continueWithdrawal")}
              </button>
            </>
          )}
          {props.runtime.error ? <p className={styles.withdrawalError}>{props.runtime.error}</p> : null}
        </section>
      ) : null}

      {props.step === "contract" ? (
        <section
          className={styles.withdrawalContract}
          data-contract-link-blocked={contractLinkBlocked ? "true" : "false"}
          data-has-signing-url={contractHasSigningUrl ? "true" : "false"}
          data-status={props.status.contractStatus}
          aria-label={t("withdrawal.contractAria")}
        >
          <div className={styles.withdrawalContractBody}>
            {contractHasSigningUrl ? (
              <div className={styles.withdrawalQrArea}>
                <div className={styles.withdrawalQrCard}>
                  <QRCodeSVG
                    className={styles.withdrawalQrImage}
                    value={signingUrl}
                    size={168}
                    level="M"
                    marginSize={4}
                    bgColor="var(--c-overlay-highlight)"
                    fgColor="var(--c-overlay-ink)"
                    title={t("withdrawal.contractQrLabel")}
                    aria-label={t("withdrawal.contractQrLabel")}
                  />
                  <span>{t("withdrawal.contractQrLabel")}</span>
                </div>
                <button className={styles.withdrawalQrExternalButton} type="button" onClick={openSigningUrlInBrowser}>
                  {t("withdrawal.openSigningInBrowser")}
                </button>
              </div>
            ) : null}
            <div className={styles.withdrawalContractCopy}>
              {contractLinkBlocked ? null : (
                <h3>
                  {contractSigningFailed ? t("withdrawal.contractFailedHeading") : t("withdrawal.contractHeading")}
                </h3>
              )}
              <p>
                {contractSigningFailed
                  ? t("withdrawal.contractFailedCopy")
                  : contractHasSigningUrl
                    ? t("withdrawal.contractActiveCopy")
                    : contractFallbackMessage}
              </p>
            </div>
          </div>
          <div className={clsx("modal-actions", styles.withdrawalContractActions)}>
            {contractHasSigningUrl && props.runtime.error ? (
              <p className={styles.withdrawalContractActionMessage}>{props.runtime.error}</p>
            ) : null}
            {contractSigningFailed ? (
              <button
                className="primary-button"
                type="button"
                disabled={props.runtime.pendingAction === "h5_sign_application"}
                onClick={() => void requestH5SignApplication()}
              >
                {props.runtime.pendingAction === "h5_sign_application"
                  ? t("withdrawal.applying")
                  : t("withdrawal.restartSigning")}
              </button>
            ) : contractHasSigningUrl ? (
              <button
                className="primary-button"
                type="button"
                disabled={props.runtime.pendingAction === "h5_sign_status"}
                onClick={() => void syncH5SignStatus()}
              >
                {props.runtime.pendingAction === "h5_sign_status"
                  ? t("withdrawal.syncing")
                  : t("withdrawal.signCompleted")}
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={props.runtime.pendingAction === "h5_sign_application"}
                onClick={() => void requestH5SignApplication()}
              >
                {props.runtime.pendingAction === "h5_sign_application"
                  ? t("withdrawal.applying")
                  : t("withdrawal.retrySigning")}
              </button>
            )}
          </div>
        </section>
      ) : null}

      {props.step === "confirm" ? (
        <section className={styles.withdrawalConfirm} aria-label={t("withdrawal.titleConfirm")}>
          <div className={styles.withdrawalActionBody}>
            <div className={styles.withdrawalConfirmAmount}>
              <span>{t("withdrawal.thisWithdrawal")}</span>
              <strong>
                {formatWithdrawalAmount(props.status.balanceCents, props.status.settlement.currency, language, t)}
              </strong>
            </div>
            <div className={styles.withdrawalConfirmRows}>
              <div>
                <span>
                  {isStripeWithdrawal ? t("withdrawal.stripeReceivingAccount") : t("withdrawal.arrivalBankCard")}
                </span>
                <strong>{bankCardLabel}</strong>
              </div>
            </div>
            {props.runtime.error ? <p className={styles.withdrawalError}>{props.runtime.error}</p> : null}
          </div>
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              disabled={props.runtime.pendingAction === "payout_order"}
              onClick={() => void submitWithdrawal()}
            >
              {props.runtime.pendingAction === "payout_order"
                ? t("withdrawal.submitting")
                : t("withdrawal.confirmSubmit")}
            </button>
          </div>
        </section>
      ) : null}

      {props.step === "records" ? (
        <section
          className={styles.withdrawalRecords}
          aria-label={t("withdrawal.titleRecords")}
          aria-busy={props.recordsPage.loading || props.recordsPage.loadingMore || props.recordsPage.syncing}
        >
          {props.recordsPage.error && visibleWithdrawalRecords.length > 0 ? (
            <p className={styles.withdrawalError}>{props.recordsPage.error}</p>
          ) : null}
          {props.recordsPage.loading && visibleWithdrawalRecords.length === 0 ? (
            <p className={styles.withdrawalRecordsEmpty}>{t("withdrawal.recordsLoading")}</p>
          ) : visibleWithdrawalRecords.length > 0 ? (
            <div className={styles.withdrawalRecordTable} role="table" aria-label={t("withdrawal.recordsTableAria")}>
              <div className={styles.withdrawalRecordTableHeader} role="row">
                <span role="columnheader">{t("withdrawal.recordTime")}</span>
                <span role="columnheader">{t("withdrawal.recordAmount")}</span>
                <span role="columnheader">{t("withdrawal.recordStatus")}</span>
              </div>
              <div className={styles.withdrawalRecordTableBody}>
                {visibleWithdrawalRecords.map((record) => (
                  <div key={record.id} className={styles.withdrawalRecordTableRow} role="row">
                    <time role="cell" dateTime={record.createdAt}>
                      {formatWithdrawalRecordTime(record.createdAt, language, t)}
                    </time>
                    <strong role="cell">
                      {formatWithdrawalAmount(record.amountCents, record.currency, language, t)}
                    </strong>
                    <WithdrawalRecordStatusCell language={language} record={record} t={t} />
                  </div>
                ))}
                {withdrawalRecordsHasMore ? (
                  <div
                    ref={recordsLoadSentinelRef}
                    className={styles.withdrawalRecordLoadSentinel}
                    aria-hidden="true"
                  />
                ) : null}
                {props.recordsPage.loadingMore ? (
                  <div className={styles.withdrawalRecordTableMeta}>{t("withdrawal.recordsLoadMore")}</div>
                ) : null}
              </div>
            </div>
          ) : props.recordsPage.error ? (
            <div className={styles.withdrawalRecordsFailure} role="alert">
              <p>{t("withdrawal.recordsLoadFailed")}</p>
              <button className="ghost-button" type="button" onClick={props.onRecordsOpen}>
                {t("withdrawal.retry")}
              </button>
            </div>
          ) : (
            <p className={styles.withdrawalRecordsEmpty}>{t("withdrawal.recordsEmpty")}</p>
          )}
        </section>
      ) : null}

      {props.step === "success" ? (
        <section className={styles.withdrawalSuccess} aria-label={t("withdrawal.successResultAria")}>
          <BadgeCheck size={44} aria-hidden="true" />
          <h3>{isStripeWithdrawal ? t("withdrawal.stripePaidHeading") : t("withdrawal.successHeading")}</h3>
          <p>{isStripeWithdrawal ? t("withdrawal.stripePaidCopy") : t("withdrawal.successCopy")}</p>
          <button className="primary-button" type="button" onClick={props.onWithdrawalSuccessComplete}>
            {t("withdrawal.complete")}
          </button>
        </section>
      ) : null}
    </div>
  );
}

function WithdrawalStat(props: { icon: LucideIcon; label: string; value: string }) {
  const Icon = props.icon;
  return (
    <div className={styles.withdrawalStat}>
      <Icon size={17} aria-hidden="true" />
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function WithdrawalField(props: {
  autoComplete: string;
  disabled?: boolean;
  inputMode?: "numeric";
  label: string;
  onChange(value: string): void;
  placeholder: string;
  value: string;
}) {
  return (
    <label className={styles.withdrawalField}>
      <span>{props.label}</span>
      <input
        autoComplete={props.autoComplete}
        disabled={props.disabled}
        inputMode={props.inputMode}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function formatWithdrawalAmount(
  cents: number,
  currency: WithdrawalStatus["settlement"]["currency"],
  language: ResolvedLanguage,
  t: TranslationFn,
): string {
  if (currency === "USD") {
    return cachedNumberFormat(language, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  }
  const amount = cachedNumberFormat(language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
  return t("withdrawal.amountCny", { amount });
}

function formatWithdrawalRecordTime(value: string, language: ResolvedLanguage, t: TranslationFn): string {
  if (!value.trim()) return t("withdrawal.recordTimePending");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return cachedDateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function WithdrawalRecordStatusCell(props: { language: ResolvedLanguage; record: WithdrawalRecord; t: TranslationFn }) {
  const detail = translatedWithdrawalRecordStatusDetail(props.record, props.t);
  return (
    <div className={styles.withdrawalRecordStatusCell} role="cell">
      <span className={styles.withdrawalRecordStatusText}>
        {translatedWithdrawalRecordStatusLabel(props.record, props.t)}
      </span>
      {detail ? (
        <span
          className={styles.withdrawalRecordStatusInfo}
          data-tooltip={detail}
          aria-label={detail}
          title={detail}
          tabIndex={0}
        >
          <HelpCircle size={13} aria-hidden="true" />
        </span>
      ) : null}
    </div>
  );
}

function translatedWithdrawalRecordStatusLabel(record: WithdrawalRecord, t: TranslationFn): string {
  switch (withdrawalRecordStatusKind(record)) {
    case "funds_preparing":
      return t("withdrawal.stripeFundsPreparing");
    case "bank_processing":
      return t("withdrawal.stripeBankProcessing");
    case "action_required":
      return t("withdrawal.stripeUpdateBankRequired");
    case "review_required":
      return t("withdrawal.stripeOrderReview");
    case "paid":
      return t("withdrawal.recordPaid");
    case "processing":
      return t("withdrawal.recordProcessing");
    case "failed":
      return t("withdrawal.recordFailed");
    case "unknown":
      return t("withdrawal.recordUnknown");
  }
}

function translatedWithdrawalRecordStatusDetail(record: WithdrawalRecord, t: TranslationFn): string {
  if (record.provider === "stripe") {
    if (record.providerStatus === "payout_action_required" && record.actionRequired === "update_bank_account") {
      return t("withdrawal.stripeUpdateBankCopy");
    }
    if (record.providerStatus === "review_required" || record.status === "review_required") {
      return t("withdrawal.stripeOrderReviewCopy");
    }
    return "";
  }
  switch (record.status.trim().toLowerCase()) {
    case "failed": {
      const failureReason = record.failureReason?.trim();
      return failureReason || t("withdrawal.recordFailedDetail");
    }
    case "cancelled":
      return t("withdrawal.recordCancelledDetail");
    case "returned":
      return t("withdrawal.recordReturnedDetail");
    case "invalid":
      return t("withdrawal.recordInvalidDetail");
    default:
      return "";
  }
}

function validateWithdrawalIdentityForm(form: WithdrawalIdentityForm, t: TranslationFn): WithdrawalIdentityErrors {
  const errors: WithdrawalIdentityErrors = {};
  const realName = form.realName.trim();
  const idCard = form.idCard.trim();
  const phoneNo = onlyDigits(form.phoneNo);
  const cardNo = onlyDigits(form.cardNo);
  if (!/^[\u4e00-\u9fa5·]{2,20}$/.test(realName)) {
    errors.realName = t("withdrawal.realNameError");
  }
  if (!/^[0-9A-Za-z]{18}$/.test(idCard)) {
    errors.idCard = t("withdrawal.idCardError");
  }
  if (!/^1\d{10}$/.test(phoneNo)) {
    errors.phoneNo = t("withdrawal.phoneNoError");
  }
  if (!/^\d{16,19}$/.test(cardNo)) {
    errors.cardNo = t("withdrawal.cardNoError");
  }
  return errors;
}

function normalizeIdCardInput(value: string): string {
  return value
    .replace(/[^0-9a-z]/gi, "")
    .slice(0, 18)
    .toUpperCase();
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function assertWithdrawalApiOk(response: Record<string, unknown>): void {
  const publicErrorName = extractWithdrawalPublicErrorName(response);
  if (publicErrorName || response.ok === false) {
    throw new Error(publicErrorName || "withdrawal_api_failed");
  }
}

function isWithdrawalPayoutFailedStatus(status: string): boolean {
  return ["cancelled", "failed", "invalid", "returned"].includes(status.trim().toLowerCase());
}

function apiErrorMessage(t: TranslationFn): string {
  return t("withdrawal.apiRequestFailed");
}

function avatarFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("avatar_read_failed"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("avatar_decode_failed"));
      image.onload = () => {
        const canvas = document.createElement("canvas");
        const size = 256;
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("avatar_canvas_unavailable"));
          return;
        }
        const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
        const sourceX = Math.max(0, (image.naturalWidth - sourceSize) / 2);
        const sourceY = Math.max(0, (image.naturalHeight - sourceSize) / 2);
        context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      };
      image.src = String(reader.result ?? "");
    };
    reader.readAsDataURL(file);
  });
}

function RailSection(props: { title: string; children: ReactNode }) {
  return (
    <section className={clsx("app-rail-section", styles.section)} aria-label={props.title}>
      <h2 className={clsx("app-rail-section-title", styles.sectionTitle)}>{props.title}</h2>
      <div className={clsx("app-rail-section-items", styles.sectionItems)}>{props.children}</div>
    </section>
  );
}

export function MobileNav(props: {
  activeView: ViewId;
  developerMode?: boolean;
  directKernelChatEnabled?: boolean;
  activeMountedAppId?: string;
  mountedApps?: ExtensionItemRecord[];
  onSelect(view: ViewId): void;
  onSelectMountedApp?(appId: string): void;
}) {
  const { t } = useI18n();
  const { preference: iconStyle } = useIconStylePreference();
  const mountedApps = [...(props.mountedApps ?? [])].sort((a, b) => compareLocalizedText(a.title, b.title));
  return (
    <nav className="mobile-nav" aria-label={t("app.mobileNav")}>
      {MOBILE_APPS.filter((item) =>
        item.view === "chat"
          ? props.directKernelChatEnabled === true
          : item.view !== "extensions" || props.developerMode === true,
      ).map((item) => {
        return (
          <button
            className={clsx("mobile-nav-item", props.activeView === item.view && "active")}
            key={item.id}
            type="button"
            onClick={() => props.onSelect(item.view)}
          >
            <RailIcon iconStyle={iconStyle} pixelIcon={item.icon} professionalIcon={PROFESSIONAL_ICONS[item.icon]} />
            <span>{appNavLabel(item.view, t)}</span>
          </button>
        );
      })}
      {mountedApps.map((app) => {
        const icon = mountedAppIcon(app);
        return (
          <button
            className={clsx(
              "mobile-nav-item",
              props.activeView === "app" && props.activeMountedAppId === app.name && "active",
            )}
            key={`mounted-app-${app.id}`}
            type="button"
            onClick={() => props.onSelectMountedApp?.(app.name)}
          >
            <AppIdentityIcon
              icon={icon}
              input={{ id: app.id, appId: app.name, title: app.title }}
              size={20}
              aria-hidden="true"
            />
            <span>{app.title}</span>
          </button>
        );
      })}
    </nav>
  );
}

function RailButton(props: {
  active?: boolean;
  sectionTarget?: RailSectionId;
  label: string;
  icon: PixelIconName;
  professionalIcon: LucideIcon;
  iconStyle: "professional" | "pixel";
  badge?: RailSectionBadge;
  onClick(): void;
}) {
  const { t } = useI18n();
  const unreadCount = props.badge?.count ?? 0;
  return (
    <button
      className={clsx("app-rail-button", styles.button)}
      data-active={props.active ? "true" : "false"}
      data-rail-section={props.sectionTarget}
      data-tooltip={props.label}
      type="button"
      onClick={props.onClick}
      aria-label={unreadCount ? t("app.unreadCount", { label: props.label, count: unreadCount }) : props.label}
      title={props.label}
    >
      <UnreadCountAnchor count={unreadCount} className={styles.iconUnreadAnchor} variant={props.badge?.variant}>
        <RailIcon iconStyle={props.iconStyle} pixelIcon={props.icon} professionalIcon={props.professionalIcon} />
      </UnreadCountAnchor>
      <span className={styles.buttonLabel}>{props.label}</span>
    </button>
  );
}

function UserAppRailItem(props: {
  active?: boolean;
  id: string;
  title: string;
  appIcon: string;
  badge?: RailSectionBadge;
  onClick(): void;
  onManageVersions?(id: string): void;
  onEdit?(id: string): void;
  onDelete?(id: string): void;
  deleteLabel?: string;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const unreadCount = props.badge?.count ?? 0;

  return (
    <div
      className={clsx("app-rail-user-tab-wrap", styles.userTabWrap)}
      data-active={props.active ? "true" : "false"}
      data-menu-open={menuOpen ? "true" : "false"}
    >
      <button
        className={clsx("app-rail-button app-rail-user-tab", styles.button, styles.userTab)}
        data-active={props.active ? "true" : "false"}
        data-tooltip={props.title}
        type="button"
        onClick={props.onClick}
        aria-label={unreadCount ? t("app.unreadCount", { label: props.title, count: unreadCount }) : props.title}
        title={props.title}
      >
        <span className={clsx("app-rail-user-tab-icon", styles.userTabIcon)} aria-hidden="true">
          <UnreadCountAnchor count={unreadCount} className={styles.iconUnreadAnchor} variant={props.badge?.variant}>
            <AppIdentityIcon
              icon={props.appIcon}
              input={{ id: props.id, title: props.title }}
              size={20}
              aria-hidden="true"
            />
          </UnreadCountAnchor>
          <span className={clsx("app-rail-user-tab-marker", styles.userTabMarker)} />
        </span>
        <span className={clsx(styles.buttonLabel, styles.userTabLabel)}>{props.title}</span>
      </button>
      <MotionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        side="right"
        align="start"
        className="app-rail-user-app-menu"
        ariaLabel={t("nav.appActions", { title: props.title })}
        tooltipContent={t("conversation.more")}
        trigger={
          <button
            className={clsx("app-rail-user-tab-menu-button", styles.userTabMenuButton)}
            type="button"
            aria-label={t("nav.appMoreActions", { title: props.title })}
            title={t("conversation.more")}
          >
            <ProductIcon name="more" system="lucide" size={15} />
          </button>
        }
      >
        {props.onManageVersions ? (
          <MotionMenuItem onClick={() => props.onManageVersions?.(props.id)}>
            <History size={15} />
            <span>{t("nav.versionManagement")}</span>
          </MotionMenuItem>
        ) : null}
        {props.onEdit ? (
          <MotionMenuItem onClick={() => props.onEdit?.(props.id)}>
            <Settings size={15} />
            <span>{t("appSettings.menuItem")}</span>
          </MotionMenuItem>
        ) : null}
        {props.onDelete ? (
          <MotionMenuItem danger onClick={() => props.onDelete?.(props.id)}>
            <Trash2 size={15} />
            <span>{props.deleteLabel ?? t("nav.deleteApp")}</span>
          </MotionMenuItem>
        ) : null}
      </MotionMenu>
    </div>
  );
}

function RailIcon(props: {
  iconStyle: "professional" | "pixel";
  pixelIcon: PixelIconName;
  professionalIcon: LucideIcon;
}) {
  if (props.iconStyle === "pixel") {
    return <PixelIcon name={props.pixelIcon} size={27} />;
  }
  const productIconName = railProductIconName(props.pixelIcon);
  if (productIconName) {
    return <ProductIcon name={productIconName} size={19} />;
  }
  const Icon = props.professionalIcon;
  return <Icon size={19} />;
}

function railProductIconName(icon: PixelIconName): ProductIconName | undefined {
  if (icon === "chat") return "chat";
  if (icon === "rooms" || icon === "messages") return "rooms";
  if (icon === "contacts" || icon === "user") return "contacts";
  if (icon === "store") return "store";
  if (icon === "ops") return "ops";
  if (icon === "extensions") return "extensions";
  if (icon === "settings") return "settings";
  if (icon === "plus") return "add";
  return undefined;
}

function appNavLabel(view: ViewId, t: TranslationFn): string {
  if (view === "chat") return t("app.chat");
  if (view === "app") return t("app.userApps");
  if (view === "rooms" || view === "contacts") return t("app.rooms");
  if (view === "app-store") return t("app.appStore");
  if (view === "ops") return t("app.ops");
  if (view === "extensions") return t("app.extensions");
  if (view === "settings") return t("app.settings");
  return t("app.chat");
}

function mountedAppIcon(app: ExtensionItemRecord): string {
  const metadataIcon =
    stringFromUnknown(app.metadata?.icon) || stringFromUnknown(recordFromUnknown(app.metadata?.ui).icon);
  return (
    metadataIcon ||
    resolveGroveAppIconName({
      icon: metadataIcon,
      id: app.id,
      appId: app.name,
      title: app.title,
    })
  );
}

function stringFromUnknown(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function ThemedPixelIcon(props: {
  pixelIcon: PixelIconName;
  professionalIcon: LucideIcon;
  professionalSize?: number;
  pixelSize?: number;
}) {
  const { preference: iconStyle } = useIconStylePreference();
  if (iconStyle === "pixel") {
    return <PixelIcon name={props.pixelIcon} size={props.pixelSize} />;
  }
  const Icon = props.professionalIcon;
  return <Icon size={props.professionalSize ?? 16} />;
}

export function PixelIcon(props: { name: PixelIconName; size?: number; className?: string }) {
  return (
    <svg
      className={clsx("pixel-icon", props.className)}
      viewBox="0 0 16 16"
      aria-hidden="true"
      shapeRendering="crispEdges"
      style={props.size ? { width: props.size, height: props.size } : undefined}
    >
      {props.name === "chat" ? (
        <>
          <rect className="pixel-icon__main" x="5" y="3" width="6" height="1" />
          <rect className="pixel-icon__main" x="4" y="4" width="1" height="1" />
          <rect className="pixel-icon__main" x="11" y="4" width="1" height="1" />
          <rect className="pixel-icon__main" x="3" y="5" width="1" height="5" />
          <rect className="pixel-icon__main" x="12" y="5" width="1" height="5" />
          <rect className="pixel-icon__main" x="4" y="10" width="2" height="1" />
          <rect className="pixel-icon__main" x="7" y="10" width="4" height="1" />
          <rect className="pixel-icon__main" x="6" y="11" width="1" height="2" />
          <rect className="pixel-icon__main" x="6" y="7" width="1" height="1" />
          <rect className="pixel-icon__main" x="8" y="7" width="1" height="1" />
          <rect className="pixel-icon__main" x="10" y="7" width="1" height="1" />
        </>
      ) : null}
      {props.name === "rooms" || props.name === "messages" ? (
        <>
          <rect className="pixel-icon__main" x="4" y="4" width="5" height="1" />
          <rect className="pixel-icon__main" x="3" y="5" width="1" height="5" />
          <rect className="pixel-icon__main" x="9" y="5" width="1" height="4" />
          <rect className="pixel-icon__main" x="4" y="10" width="2" height="1" />
          <rect className="pixel-icon__main" x="7" y="9" width="2" height="1" />
          <rect className="pixel-icon__main" x="6" y="11" width="1" height="2" />
          <rect className="pixel-icon__main" x="6" y="7" width="1" height="1" />
          <rect className="pixel-icon__main" x="8" y="7" width="1" height="1" />
          <rect className="pixel-icon__main" x="9" y="6" width="3" height="1" />
          <rect className="pixel-icon__main" x="12" y="7" width="1" height="5" />
          <rect className="pixel-icon__main" x="8" y="12" width="4" height="1" />
          <rect className="pixel-icon__main" x="10" y="13" width="1" height="2" />
          <rect className="pixel-icon__main" x="10" y="9" width="1" height="1" />
          <rect className="pixel-icon__accent" x="11" y="10" width="1" height="1" />
        </>
      ) : null}
      {props.name === "contacts" ? (
        <>
          <rect className="pixel-icon__main" x="5" y="2" width="7" height="1" />
          <rect className="pixel-icon__main" x="4" y="3" width="1" height="10" />
          <rect className="pixel-icon__main" x="12" y="3" width="1" height="10" />
          <rect className="pixel-icon__main" x="5" y="13" width="7" height="1" />
          <rect className="pixel-icon__main" x="3" y="4" width="1" height="1" />
          <rect className="pixel-icon__main" x="3" y="6" width="1" height="1" />
          <rect className="pixel-icon__main" x="3" y="8" width="1" height="1" />
          <rect className="pixel-icon__main" x="3" y="10" width="1" height="1" />
          <rect className="pixel-icon__accent" x="8" y="5" width="2" height="2" />
          <rect className="pixel-icon__accent" x="7" y="8" width="4" height="2" />
          <rect className="pixel-icon__accent" x="6" y="10" width="6" height="1" />
        </>
      ) : null}
      {props.name === "folder" ? (
        <>
          <rect className="pixel-icon__accent" x="2" y="4" width="4" height="1" />
          <rect className="pixel-icon__accent" x="2" y="5" width="5" height="1" />
          <rect className="pixel-icon__main" x="1" y="6" width="1" height="7" />
          <rect className="pixel-icon__main" x="2" y="5" width="4" height="1" />
          <rect className="pixel-icon__main" x="6" y="6" width="8" height="1" />
          <rect className="pixel-icon__main" x="14" y="7" width="1" height="6" />
          <rect className="pixel-icon__main" x="2" y="13" width="12" height="1" />
        </>
      ) : null}
      {props.name === "library" || props.name === "document" ? (
        <>
          <rect className="pixel-icon__main" x="4" y="2" width="6" height="1" />
          <rect className="pixel-icon__main" x="3" y="3" width="1" height="10" />
          <rect className="pixel-icon__main" x="10" y="3" width="1" height="2" />
          <rect className="pixel-icon__main" x="11" y="5" width="2" height="1" />
          <rect className="pixel-icon__main" x="13" y="6" width="1" height="7" />
          <rect className="pixel-icon__main" x="4" y="13" width="9" height="1" />
          <rect className="pixel-icon__main" x="11" y="4" width="1" height="1" />
          <rect className="pixel-icon__accent" x="6" y="7" width="1" height="1" />
          <rect className="pixel-icon__accent" x="8" y="7" width="3" height="1" />
          <rect className="pixel-icon__accent" x="6" y="9" width="1" height="1" />
          <rect className="pixel-icon__accent" x="8" y="9" width="4" height="1" />
          <rect className="pixel-icon__accent" x="6" y="11" width="1" height="1" />
          <rect className="pixel-icon__accent" x="8" y="11" width="4" height="1" />
        </>
      ) : null}
      {props.name === "seed" ? (
        <>
          <rect className="pixel-icon__main" x="7" y="11" width="2" height="3" />
          <rect className="pixel-icon__main" x="8" y="9" width="1" height="2" />
          <rect className="pixel-icon__main" x="6" y="10" width="2" height="1" />
          <rect className="pixel-icon__main" x="5" y="9" width="1" height="1" />
          <rect className="pixel-icon__main" x="4" y="7" width="1" height="2" />
          <rect className="pixel-icon__main" x="5" y="6" width="2" height="1" />
          <rect className="pixel-icon__main" x="7" y="7" width="1" height="2" />
          <rect className="pixel-icon__accent" x="9" y="9" width="2" height="1" />
          <rect className="pixel-icon__accent" x="11" y="8" width="1" height="1" />
          <rect className="pixel-icon__accent" x="12" y="6" width="1" height="2" />
          <rect className="pixel-icon__accent" x="10" y="5" width="2" height="1" />
          <rect className="pixel-icon__accent" x="9" y="6" width="1" height="3" />
        </>
      ) : null}
      {props.name === "search" ? (
        <>
          <rect className="pixel-icon__main" x="5" y="3" width="4" height="1" />
          <rect className="pixel-icon__main" x="4" y="4" width="1" height="1" />
          <rect className="pixel-icon__main" x="9" y="4" width="1" height="1" />
          <rect className="pixel-icon__main" x="3" y="5" width="1" height="4" />
          <rect className="pixel-icon__main" x="10" y="5" width="1" height="4" />
          <rect className="pixel-icon__main" x="4" y="9" width="1" height="1" />
          <rect className="pixel-icon__main" x="9" y="9" width="1" height="1" />
          <rect className="pixel-icon__main" x="5" y="10" width="4" height="1" />
          <rect className="pixel-icon__main" x="10" y="10" width="1" height="1" />
          <rect className="pixel-icon__main" x="11" y="11" width="1" height="1" />
          <rect className="pixel-icon__main" x="12" y="12" width="1" height="2" />
          <rect className="pixel-icon__accent" x="9" y="9" width="1" height="1" />
        </>
      ) : null}
      {props.name === "plus" ? (
        <>
          <rect className="pixel-icon__main" x="4" y="3" width="8" height="1" />
          <rect className="pixel-icon__main" x="3" y="4" width="1" height="8" />
          <rect className="pixel-icon__main" x="12" y="4" width="1" height="8" />
          <rect className="pixel-icon__main" x="4" y="12" width="8" height="1" />
          <rect className="pixel-icon__accent" x="7" y="5" width="2" height="6" />
          <rect className="pixel-icon__accent" x="5" y="7" width="6" height="2" />
        </>
      ) : null}
      {props.name === "ops" ? (
        <>
          <rect className="pixel-icon__main" x="2" y="3" width="12" height="1" />
          <rect className="pixel-icon__main" x="2" y="12" width="12" height="1" />
          <rect className="pixel-icon__main" x="2" y="4" width="1" height="8" />
          <rect className="pixel-icon__main" x="13" y="4" width="1" height="8" />
          <rect className="pixel-icon__accent" x="4" y="9" width="1" height="2" />
          <rect className="pixel-icon__accent" x="6" y="7" width="1" height="4" />
          <rect className="pixel-icon__accent" x="8" y="5" width="1" height="6" />
          <rect className="pixel-icon__accent" x="10" y="8" width="1" height="3" />
          <rect className="pixel-icon__main" x="4" y="5" width="1" height="1" />
          <rect className="pixel-icon__main" x="5" y="6" width="1" height="1" />
          <rect className="pixel-icon__main" x="9" y="6" width="1" height="1" />
          <rect className="pixel-icon__main" x="10" y="5" width="1" height="1" />
        </>
      ) : null}
      {props.name === "extensions" ? (
        <>
          <rect className="pixel-icon__main" x="4" y="2" width="8" height="1" />
          <rect className="pixel-icon__main" x="3" y="3" width="1" height="10" />
          <rect className="pixel-icon__main" x="12" y="3" width="1" height="10" />
          <rect className="pixel-icon__main" x="4" y="13" width="8" height="1" />
          <rect className="pixel-icon__main" x="5" y="5" width="2" height="2" />
          <rect className="pixel-icon__main" x="9" y="5" width="2" height="2" />
          <rect className="pixel-icon__main" x="5" y="9" width="2" height="2" />
          <rect className="pixel-icon__main" x="9" y="9" width="2" height="2" />
          <rect className="pixel-icon__accent" x="7" y="7" width="2" height="2" />
        </>
      ) : null}
      {props.name === "store" ? (
        <>
          <rect className="pixel-icon__main" x="3" y="5" width="10" height="1" />
          <rect className="pixel-icon__main" x="2" y="6" width="1" height="7" />
          <rect className="pixel-icon__main" x="13" y="6" width="1" height="7" />
          <rect className="pixel-icon__main" x="3" y="13" width="10" height="1" />
          <rect className="pixel-icon__main" x="4" y="3" width="8" height="1" />
          <rect className="pixel-icon__main" x="5" y="2" width="6" height="1" />
          <rect className="pixel-icon__accent" x="5" y="8" width="2" height="2" />
          <rect className="pixel-icon__accent" x="9" y="8" width="2" height="2" />
          <rect className="pixel-icon__accent" x="5" y="11" width="6" height="1" />
        </>
      ) : null}
      {props.name === "settings" ? (
        <>
          <rect className="pixel-icon__main" x="7" y="2" width="2" height="2" />
          <rect className="pixel-icon__main" x="4" y="3" width="2" height="1" />
          <rect className="pixel-icon__main" x="10" y="3" width="2" height="1" />
          <rect className="pixel-icon__main" x="3" y="4" width="1" height="2" />
          <rect className="pixel-icon__main" x="12" y="4" width="1" height="2" />
          <rect className="pixel-icon__main" x="2" y="7" width="2" height="2" />
          <rect className="pixel-icon__main" x="12" y="7" width="2" height="2" />
          <rect className="pixel-icon__main" x="3" y="10" width="1" height="2" />
          <rect className="pixel-icon__main" x="12" y="10" width="1" height="2" />
          <rect className="pixel-icon__main" x="4" y="12" width="2" height="1" />
          <rect className="pixel-icon__main" x="10" y="12" width="2" height="1" />
          <rect className="pixel-icon__main" x="7" y="12" width="2" height="2" />
          <rect className="pixel-icon__accent" x="7" y="7" width="2" height="2" />
        </>
      ) : null}
      {props.name === "user" ? (
        <>
          <rect className="pixel-icon__main" x="6" y="3" width="4" height="1" />
          <rect className="pixel-icon__main" x="5" y="4" width="1" height="3" />
          <rect className="pixel-icon__main" x="10" y="4" width="1" height="3" />
          <rect className="pixel-icon__main" x="6" y="7" width="4" height="1" />
          <rect className="pixel-icon__main" x="4" y="10" width="1" height="2" />
          <rect className="pixel-icon__main" x="11" y="10" width="1" height="2" />
          <rect className="pixel-icon__main" x="5" y="9" width="6" height="1" />
          <rect className="pixel-icon__main" x="5" y="12" width="6" height="1" />
          <rect className="pixel-icon__accent" x="5" y="10" width="6" height="2" />
        </>
      ) : null}
    </svg>
  );
}
