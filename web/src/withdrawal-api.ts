import { getJson, postEmptyJson, postJson } from "./bridge-client";

export type WithdrawalApiResponse = Record<string, unknown>;

export type WithdrawalPayoutProvider = "yunzhanghu" | "stripe";
export type WithdrawalCurrency = "CNY" | "USD";

export interface WithdrawalSettlement {
  countryCode: string;
  provider: WithdrawalPayoutProvider;
  currency: WithdrawalCurrency;
}

export type StripeConnectMissingRequirement =
  | "consent"
  | "connected_account"
  | "account_requirements"
  | "account_verification_pending"
  | "payouts_enabled"
  | "manual_payout_schedule"
  | "tax_enforcement"
  | "usd_bank_account";

export interface StripeConnectRequirementError {
  code: string;
  requirement: string;
}

export interface StripeConnectAccountStatus {
  accountId: string;
  country: string;
  defaultCurrency: string;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  payoutScheduleManual: boolean;
  requirementsState: string;
  currentlyDue: string[];
  pendingVerification: string[];
  pastDue: string[];
  requirementsErrors: StripeConnectRequirementError[];
  externalAccountCurrency?: string;
  externalAccountBankName?: string;
  externalAccountLast4?: string;
  externalAccountStatus?: string;
  lastSyncedAt?: string;
}

export interface StripeConnectStatus {
  consentAccepted: boolean;
  readyForPayout: boolean;
  missingRequirements: string[];
  account?: StripeConnectAccountStatus;
}

export interface WithdrawalActivePayout {
  amountCents: number;
  actionRequired: string;
  currency: WithdrawalCurrency;
  createdAt: string;
  orderId: string;
  provider: WithdrawalPayoutProvider;
  providerStatus: string;
  status: string;
}

export interface WithdrawalRecord {
  actionRequired: string;
  amountCents: number;
  channel: string;
  currency: WithdrawalCurrency;
  createdAt: string;
  failureReason: string;
  finishedAt: string | null;
  id: string;
  provider: WithdrawalPayoutProvider;
  providerStatus: string;
  status: string;
  updatedAt: string;
}

export type WithdrawalRecordStatusKind =
  | "funds_preparing"
  | "bank_processing"
  | "action_required"
  | "review_required"
  | "paid"
  | "processing"
  | "failed"
  | "unknown";

export type WithdrawalProfileReviewStatus = "missing" | "pending" | "verified" | "rejected";
export type WithdrawalContractStatus = "not_started" | "signing" | "signed" | "terminated" | "expired" | "failed";

export interface WithdrawalProfileFieldErrors {
  realName?: string;
  idCard?: string;
  phoneNo?: string;
  cardNo?: string;
}

export interface WithdrawalVerificationFailure {
  fieldErrors: WithdrawalProfileFieldErrors;
  message: string;
}

export type WithdrawalPublicErrorName =
  | "PAYOUT_PROFILE_REQUIRED"
  | "PAYOUT_PROFILE_ALREADY_EXISTS"
  | "ID_CARD_ALREADY_BOUND"
  | "IDENTITY_VERIFICATION_FAILED"
  | "BANK_CARD_VERIFICATION_FAILED"
  | "SIGN_APPLICATION_IN_PROGRESS"
  | "SIGN_REQUIRED"
  | "NO_WITHDRAWABLE_BALANCE"
  | "YZH_UNAVAILABLE"
  | "PAYOUT_REQUEST_IN_PROGRESS"
  | "PAYOUT_DAILY_LIMIT_EXCEEDED"
  | "STRIPE_CONSENT_REQUIRED"
  | "STRIPE_CONNECT_NOT_READY"
  | "STRIPE_UNAVAILABLE"
  | "PAYOUT_AMOUNT_LIMIT_EXCEEDED"
  | "SERVICE_UNAVAILABLE"
  | "ACCESS_TOKEN_INVALID"
  | "SESSION_REQUIRED";

const WITHDRAWAL_PUBLIC_ERROR_CODE_MAP: Record<string, WithdrawalPublicErrorName> = {
  "100004": "SERVICE_UNAVAILABLE",
  "101301": "PAYOUT_PROFILE_REQUIRED",
  "101302": "PAYOUT_PROFILE_ALREADY_EXISTS",
  "101303": "ID_CARD_ALREADY_BOUND",
  "101304": "IDENTITY_VERIFICATION_FAILED",
  "101305": "BANK_CARD_VERIFICATION_FAILED",
  "101306": "SIGN_APPLICATION_IN_PROGRESS",
  "101307": "SIGN_REQUIRED",
  "101308": "NO_WITHDRAWABLE_BALANCE",
  "101309": "YZH_UNAVAILABLE",
  "101310": "PAYOUT_REQUEST_IN_PROGRESS",
  "101311": "PAYOUT_DAILY_LIMIT_EXCEEDED",
  "101312": "STRIPE_CONSENT_REQUIRED",
  "101313": "STRIPE_CONNECT_NOT_READY",
  "101314": "STRIPE_UNAVAILABLE",
  "101315": "PAYOUT_AMOUNT_LIMIT_EXCEEDED",
};

export interface WithdrawalStatus {
  settlement: WithdrawalSettlement;
  stripeConnect: StripeConnectStatus | null;
  balanceCents: number;
  withdrawalCount: number;
  totalEarningsCents: number;
  frozenCents: number;
  totalWithdrawnCents: number;
  identityInfoStatus: WithdrawalProfileReviewStatus;
  bankCardStatus: WithdrawalProfileReviewStatus;
  contractStatus: WithdrawalContractStatus;
  signingUrl: string;
  bankCardLast4: string;
  profileFieldErrors: WithdrawalProfileFieldErrors;
  payoutInProgress: boolean;
  activePayout: WithdrawalActivePayout | null;
  withdrawalRecords: WithdrawalRecord[];
  recordsStatus: "ready" | "unavailable";
}

export type WithdrawalContractState = Pick<WithdrawalStatus, "contractStatus" | "signingUrl">;

export interface WithdrawalRecordsPage {
  page: number;
  pageSize: number;
  records: WithdrawalRecord[];
  total: number;
}

export async function readWithdrawalStatus(): Promise<WithdrawalStatus> {
  const userResponse = await getJson<WithdrawalApiResponse>("/v1/users/me");
  const settlement = normalizeWithdrawalSettlement(userResponse);
  if (!settlement) throw new Error("withdrawal_settlement_invalid");
  const [providerResponse, ordersResponse] = await Promise.all([
    settlement.provider === "stripe"
      ? getJson<WithdrawalApiResponse>("/v1/stripe-connect/status")
      : getJson<WithdrawalApiResponse>("/v1/payment/payout-profile/status"),
    getJson<WithdrawalApiResponse>("/v1/payout-orders?page=1&page_size=20").catch(() => undefined),
  ]);
  const status = normalizeWithdrawalStatus(userResponse, providerResponse, ordersResponse);
  if (!status) throw new Error("withdrawal_status_invalid");
  return status;
}

export async function readStripeConnectStatus(): Promise<StripeConnectStatus> {
  const response = await getJson<WithdrawalApiResponse>("/v1/stripe-connect/status");
  const status = normalizeStripeConnectStatus(response);
  if (!status) throw new Error("stripe_connect_status_invalid");
  return status;
}

export async function readWithdrawalContractState(): Promise<WithdrawalContractState> {
  const response = await getJson<WithdrawalApiResponse>("/v1/payment/payout-profile/status");
  const state = normalizeWithdrawalContractState(response);
  if (!state) throw new Error("withdrawal_contract_status_invalid");
  return state;
}

export function normalizeWithdrawalContractState(value: unknown): WithdrawalContractState | null {
  const profile = responseData(value);
  if (!profile) return null;
  return {
    contractStatus: normalizeContractStatus(profile),
    signingUrl: extractPaymentUrl(profile),
  };
}

export async function readWithdrawalOverviewStatus(): Promise<WithdrawalStatus> {
  const [userResponse, ordersResponse] = await Promise.all([
    getJson<WithdrawalApiResponse>("/v1/users/me"),
    getJson<WithdrawalApiResponse>("/v1/payout-orders?page=1&page_size=20").catch(() => undefined),
  ]);
  const status = normalizeWithdrawalOverviewStatus(userResponse, ordersResponse);
  if (!status) throw new Error("withdrawal_status_invalid");
  return status;
}

export async function readWithdrawalRecordsPage(page: number, pageSize: number): Promise<WithdrawalRecordsPage> {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(50, Math.max(1, Math.floor(pageSize)));
  const response = await getJson<WithdrawalApiResponse>(`/v1/payout-orders?page=${safePage}&page_size=${safePageSize}`);
  const orders = normalizePayoutOrders(response);
  if (!orders) throw new Error("withdrawal_records_invalid");
  return {
    page: safePage,
    pageSize: safePageSize,
    records: orders.records,
    total: orders.total,
  };
}

export async function readPayoutOrder(orderId: string): Promise<WithdrawalRecord> {
  const response = await getJson<WithdrawalApiResponse>(`/v1/payout-orders/${encodeURIComponent(orderId)}`);
  const record = normalizeWithdrawalRecord(responseData(response));
  if (!record) throw new Error("withdrawal_order_invalid");
  return record;
}

export function normalizeWithdrawalSettlement(value: unknown): WithdrawalSettlement | null {
  const user = responseData(value);
  if (!user) return null;
  const countryCode = typeof user.country_code === "string" ? user.country_code.trim().toUpperCase() : "";
  const provider = typeof user.payout_provider === "string" ? user.payout_provider.trim().toLowerCase() : "";
  const currency = typeof user.cash_currency === "string" ? user.cash_currency.trim().toUpperCase() : "";

  // Compatibility boundary for #768: remove after every existing WW user has explicit settlement fields.
  if (!countryCode && !provider && !currency) {
    return { countryCode: "CN", provider: "yunzhanghu", currency: "CNY" };
  }
  if (countryCode === "CN" && provider === "yunzhanghu" && currency === "CNY") {
    return { countryCode, provider, currency };
  }
  if (countryCode && countryCode !== "CN" && provider === "stripe" && currency === "USD") {
    return { countryCode, provider, currency };
  }
  return null;
}

export function normalizeStripeConnectStatus(value: unknown): StripeConnectStatus | null {
  const data = responseData(value);
  if (!data) return null;
  if (typeof data.consent_accepted !== "boolean" || typeof data.ready_for_payout !== "boolean") return null;
  const missingRequirements = stringArray(data.missing_requirements);
  if (!missingRequirements) return null;
  const account = data.account === undefined ? undefined : normalizeStripeConnectAccountStatus(data.account);
  if (data.account !== undefined && !account) return null;
  return {
    consentAccepted: data.consent_accepted,
    readyForPayout: data.ready_for_payout,
    missingRequirements,
    ...(account ? { account } : {}),
  };
}

export function normalizeWithdrawalStatus(
  userValue: unknown,
  profileValue: unknown,
  ordersValue: unknown,
): WithdrawalStatus | null {
  const user = responseData(userValue);
  const settlement = normalizeWithdrawalSettlement(userValue);
  const providerStatus = responseData(profileValue);
  if (!user || !settlement || !providerStatus) return null;
  const balanceCents = nonNegativeInteger(user.cash_balance_cents);
  const frozenCents = nonNegativeInteger(user.cash_frozen_cents);
  const totalEarningsCents = nonNegativeInteger(user.total_cash_earned_cents);
  const totalWithdrawnCents = nonNegativeInteger(user.total_cash_withdrawn_cents);
  if (balanceCents === null || frozenCents === null || totalEarningsCents === null || totalWithdrawnCents === null)
    return null;
  const orders = normalizePayoutOrders(ordersValue);
  const withdrawalRecords = orders?.records ?? [];
  const stripeConnect = settlement.provider === "stripe" ? normalizeStripeConnectStatus(profileValue) : null;
  if (settlement.provider === "stripe" && !stripeConnect) return null;
  const bankCardNo =
    settlement.provider === "stripe"
      ? (stripeConnect?.account?.externalAccountLast4 ?? "")
      : typeof providerStatus.bank_card_no === "string"
        ? providerStatus.bank_card_no.trim()
        : "";
  const activePayout =
    settlement.provider === "stripe"
      ? activePayoutFromRecords(withdrawalRecords, "stripe")
      : (normalizeActivePayout(providerStatus.active_payout) ?? activePayoutFromRecords(withdrawalRecords));
  return {
    settlement,
    stripeConnect,
    balanceCents,
    frozenCents,
    totalEarningsCents,
    totalWithdrawnCents,
    withdrawalCount: orders?.total ?? 0,
    identityInfoStatus:
      settlement.provider === "stripe"
        ? stripeConnect?.account
          ? "verified"
          : "missing"
        : normalizeIdentityInfoStatus(providerStatus),
    bankCardStatus:
      settlement.provider === "stripe"
        ? stripeConnect?.account?.externalAccountLast4
          ? "verified"
          : "missing"
        : normalizeBankCardStatus(providerStatus),
    contractStatus:
      settlement.provider === "stripe"
        ? stripeConnect?.consentAccepted
          ? "signed"
          : "not_started"
        : normalizeContractStatus(providerStatus),
    signingUrl: settlement.provider === "stripe" ? "" : extractPaymentUrl(providerStatus),
    bankCardLast4: bankCardNo.length >= 4 ? bankCardNo.slice(-4) : "",
    profileFieldErrors: settlement.provider === "stripe" ? {} : extractWithdrawalProfileFieldErrors(providerStatus),
    payoutInProgress:
      providerStatus.payout_in_progress === true ||
      activePayout !== null ||
      (settlement.provider === "stripe" && frozenCents > 0),
    activePayout,
    withdrawalRecords,
    recordsStatus: orders ? "ready" : "unavailable",
  };
}

export function normalizeWithdrawalOverviewStatus(userValue: unknown, ordersValue?: unknown): WithdrawalStatus | null {
  const user = responseData(userValue);
  const settlement = normalizeWithdrawalSettlement(userValue);
  if (!user || !settlement) return null;
  const balanceCents = nonNegativeInteger(user.cash_balance_cents);
  const frozenCents = nonNegativeInteger(user.cash_frozen_cents);
  const totalEarningsCents = nonNegativeInteger(user.total_cash_earned_cents);
  const totalWithdrawnCents = nonNegativeInteger(user.total_cash_withdrawn_cents);
  if (balanceCents === null || frozenCents === null || totalEarningsCents === null || totalWithdrawnCents === null)
    return null;
  const orders = normalizePayoutOrders(ordersValue);
  const withdrawalRecords = orders?.records ?? [];
  const activePayout = activePayoutFromRecords(withdrawalRecords, settlement.provider);
  return {
    settlement,
    stripeConnect: null,
    balanceCents,
    frozenCents,
    totalEarningsCents,
    totalWithdrawnCents,
    withdrawalCount: orders?.total ?? withdrawalRecords.length,
    identityInfoStatus: "missing",
    bankCardStatus: "missing",
    contractStatus: "not_started",
    signingUrl: "",
    bankCardLast4: "",
    profileFieldErrors: {},
    payoutInProgress: activePayout !== null || (settlement.provider === "stripe" && frozenCents > 0),
    activePayout,
    withdrawalRecords,
    recordsStatus: orders ? "ready" : "unavailable",
  };
}

export function createPayoutProfileVerification(payload: Record<string, unknown>): Promise<WithdrawalApiResponse> {
  return postJson<WithdrawalApiResponse>("/v1/payment/payout-profile/verifications", payload);
}

export function createH5SignApplication(): Promise<WithdrawalApiResponse> {
  return postEmptyJson<WithdrawalApiResponse>("/v1/payment/h5-sign/applications");
}

export function createStripeOnboardingLink(): Promise<WithdrawalApiResponse> {
  return postEmptyJson<WithdrawalApiResponse>("/v1/stripe-connect/tax-onboarding-links");
}

export async function syncStripeConnectStatus(): Promise<StripeConnectStatus> {
  const response = await postEmptyJson<WithdrawalApiResponse>("/v1/stripe-connect/sync");
  const status = normalizeStripeConnectStatus(response);
  if (!status) throw new Error("stripe_connect_status_invalid");
  return status;
}

export function createPayoutOrder(): Promise<WithdrawalApiResponse> {
  return postEmptyJson<WithdrawalApiResponse>("/v1/payout-orders");
}

export function syncPayoutOrder(orderId: string): Promise<WithdrawalApiResponse> {
  return postEmptyJson<WithdrawalApiResponse>(`/v1/payout-orders/${encodeURIComponent(orderId)}/sync`);
}

export function isWithdrawalRecordInProgress(recordOrStatus: WithdrawalRecord | string): boolean {
  const status = typeof recordOrStatus === "string" ? recordOrStatus : recordOrStatus.status;
  switch (status.trim().toLowerCase()) {
    case "created":
    case "submitting":
    case "processing":
    case "hanging":
    case "review_required":
      return true;
    default:
      return false;
  }
}

export function withdrawalRecordStatusKind(
  record: Pick<WithdrawalRecord, "actionRequired" | "provider" | "providerStatus" | "status">,
): WithdrawalRecordStatusKind {
  const status = record.status.trim().toLowerCase();
  const providerStatus = record.providerStatus.trim().toLowerCase();
  if (status === "paid" || providerStatus === "paid") return "paid";
  if (["failed", "cancelled", "returned", "invalid"].includes(status)) return "failed";
  if (record.provider === "stripe") {
    if (status === "review_required" || providerStatus === "review_required") return "review_required";
    if (record.actionRequired === "update_bank_account" || providerStatus === "payout_action_required")
      return "action_required";
    if (providerStatus === "waiting_platform_funds") return "funds_preparing";
    if (providerStatus === "payout_pending") return "bank_processing";
  }
  if (isWithdrawalRecordInProgress(status)) return "processing";
  return "unknown";
}

export function withdrawalRecordStatusLabel(record: WithdrawalRecord): string {
  switch (withdrawalRecordStatusKind(record)) {
    case "funds_preparing":
      return "资金准备中";
    case "bank_processing":
      return "银行处理中";
    case "action_required":
      return "需要更新收款账户";
    case "review_required":
      return "正在人工核查";
    case "paid":
      return "已到账";
    case "processing":
      return "提现中";
    case "failed":
      return "提现失败";
    case "unknown":
      return "状态待返回";
  }
}

export function withdrawalRecordStatusDetail(record: WithdrawalRecord): string {
  if (record.provider === "stripe") {
    if (record.providerStatus === "payout_action_required" && record.actionRequired === "update_bank_account") {
      return "金额仍在冻结中，请更新收款账户后重试。";
    }
    if (record.providerStatus === "review_required" || record.status === "review_required") {
      return "订单正在人工核查，金额仍在冻结中。";
    }
    return "";
  }
  switch (record.status.trim().toLowerCase()) {
    case "failed":
      return record.failureReason || "提现失败。";
    case "cancelled":
      return "提现已被取消，金额退回余额。";
    case "returned":
      return "提现已退回，金额已退回余额。";
    case "invalid":
      return "提现订单无效。";
    default:
      return "";
  }
}

export function extractWithdrawalProfileFieldErrors(value: unknown): WithdrawalProfileFieldErrors {
  const source = firstRecord(value, [
    "field_errors",
    "fieldErrors",
    "profile_field_errors",
    "profileFieldErrors",
    "validation_errors",
    "validationErrors",
    "data.field_errors",
    "data.fieldErrors",
    "data.profile_field_errors",
    "data.profileFieldErrors",
    "data.validation_errors",
    "data.validationErrors",
  ]);
  if (!source) return {};
  return compactProfileFieldErrors({
    realName: firstString(source, ["real_name", "realName", "name"]),
    idCard: firstString(source, ["id_card", "idCard", "identity_card", "identityCard"]),
    phoneNo: firstString(source, ["phone_no", "phoneNo", "mobile", "phone", "mobile_no", "mobileNo"]),
    cardNo: firstString(source, ["bank_card_no", "bankCardNo", "cardNo"]),
  });
}

export function extractWithdrawalVerificationFailure(
  response: unknown,
  phase: "identity" | "bank_card",
): WithdrawalVerificationFailure | null {
  const fieldErrors = extractWithdrawalProfileFieldErrors(response);
  const code = extractWithdrawalBusinessCode(response);
  if (code === "0000" || code === "0") return null;
  const message = extractWithdrawalBusinessMessage(response);
  if (code) {
    return {
      fieldErrors: hasProfileFieldErrors(fieldErrors)
        ? fieldErrors
        : withdrawalBusinessCodeFieldErrors(code, phase, message),
      message: message || "信息验证失败，请检查后重新提交。",
    };
  }
  if (isResponseExplicitlyFailed(response)) {
    return {
      fieldErrors,
      message: message || "信息验证失败，请检查后重新提交。",
    };
  }
  return null;
}

export function extractWithdrawalPublicErrorName(value: unknown): WithdrawalPublicErrorName | "" {
  const candidates =
    value instanceof Error
      ? [
          value.message,
          ...stringsOrNumbersAtPaths(value, [
            "code",
            "error",
            "error.message",
            "error.error",
            "error.error_name",
            "error.errorName",
            "error.name",
            "error.code_name",
            "error.codeName",
            "error.code",
          ]),
        ]
      : stringsOrNumbersAtPaths(value, [
          "error",
          "error.message",
          "error.error",
          "error.error_name",
          "error.errorName",
          "error.name",
          "error.code_name",
          "error.codeName",
          "error.code",
          "error.status_code",
          "error.statusCode",
          "error.error_code",
          "error.errorCode",
          "message",
          "error_message",
          "errorMessage",
          "error_name",
          "errorName",
          "name",
          "code_name",
          "codeName",
          "code",
          "status_code",
          "statusCode",
          "error_code",
          "errorCode",
          "data.error",
          "data.error.message",
          "data.error.error",
          "data.error.error_name",
          "data.error.errorName",
          "data.error.name",
          "data.error.code_name",
          "data.error.codeName",
          "data.error.code",
          "data.error.status_code",
          "data.error.statusCode",
          "data.error.error_code",
          "data.error.errorCode",
          "data.message",
          "data.error_message",
          "data.errorMessage",
          "data.error_name",
          "data.errorName",
          "data.name",
          "data.code_name",
          "data.codeName",
          "data.code",
          "data.status_code",
          "data.statusCode",
          "data.error_code",
          "data.errorCode",
        ]);
  for (const raw of candidates) {
    const normalized = raw.trim().toUpperCase();
    if (isWithdrawalPublicErrorName(normalized)) return normalized;
    const mapped = WITHDRAWAL_PUBLIC_ERROR_CODE_MAP[raw.trim()];
    if (mapped) return mapped;
  }
  return "";
}

export function isWithdrawalAuthExpiredError(value: unknown): boolean {
  const name = extractWithdrawalPublicErrorName(value);
  return name === "ACCESS_TOKEN_INVALID" || name === "SESSION_REQUIRED";
}

export function withdrawalProfileSubmissionErrorMessage(value: unknown): string {
  switch (extractWithdrawalPublicErrorName(value)) {
    case "PAYOUT_PROFILE_ALREADY_EXISTS":
      return "当前身份信息已存在";
    case "ID_CARD_ALREADY_BOUND":
      return "当前身份证已被使用，请联系产品处理";
    case "IDENTITY_VERIFICATION_FAILED":
      return "请核对姓名和身份证号。";
    case "BANK_CARD_VERIFICATION_FAILED":
      return "请核对银行卡和姓名、身份证、手机号。";
    case "YZH_UNAVAILABLE":
      return "请稍后重试。";
    default:
      return "";
  }
}

export function withdrawalSignApplicationErrorMessage(value: unknown): string {
  switch (extractWithdrawalPublicErrorName(value)) {
    case "SIGN_APPLICATION_IN_PROGRESS":
      return "已有签约申请处理中，请等当前签约流程结束后重试";
    case "YZH_UNAVAILABLE":
      return "请稍后重试。";
    default:
      return "";
  }
}

export function withdrawalPayoutSubmissionErrorMessage(value: unknown): string {
  switch (extractWithdrawalPublicErrorName(value)) {
    case "PAYOUT_PROFILE_REQUIRED":
      return "请先完成提现信息填写";
    case "SIGN_REQUIRED":
      return "请先完成劳动者签约";
    case "NO_WITHDRAWABLE_BALANCE":
      return "当前没有可提现余额";
    case "PAYOUT_REQUEST_IN_PROGRESS":
      return "已有提现正在处理中";
    case "PAYOUT_DAILY_LIMIT_EXCEEDED":
      return "今天已提交过提现，请明天再试";
    case "STRIPE_CONSENT_REQUIRED":
      return "请先到故事种子完成创作者签约";
    case "STRIPE_CONNECT_NOT_READY":
      return "请先完成 Stripe 收款账户设置";
    case "STRIPE_UNAVAILABLE":
      return "Stripe 暂时不可用，请稍后重试。";
    case "PAYOUT_AMOUNT_LIMIT_EXCEEDED":
      return "单次提现上限为 $1,000.00";
    case "SERVICE_UNAVAILABLE":
      return "请稍后重试。";
    default:
      return "";
  }
}

export function withdrawalOrderSyncErrorMessage(value: unknown): string {
  switch (extractWithdrawalPublicErrorName(value)) {
    case "SERVICE_UNAVAILABLE":
      return "请稍后重试。";
    default:
      return "";
  }
}

export function extractPaymentUrl(response: unknown): string {
  const value = firstString(response, [
    "url",
    "h5_url",
    "h5Url",
    "sign_url",
    "signUrl",
    "signing_url",
    "signingUrl",
    "application_url",
    "applicationUrl",
    "data.url",
    "data.h5_url",
    "data.h5Url",
    "data.sign_url",
    "data.signUrl",
    "data.signing_url",
    "data.signingUrl",
    "data.application_url",
    "data.applicationUrl",
  ]);
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function extractStripeHostedOnboardingUrl(response: unknown): string {
  const value = firstString(response, ["url", "data.url"]);
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "connect.stripe.com" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function extractPaymentStatus(response: unknown): string {
  return firstString(response, [
    "status",
    "sign_status",
    "signStatus",
    "h5_sign_status",
    "h5SignStatus",
    "contract_status",
    "contractStatus",
    "data.status",
    "data.sign_status",
    "data.signStatus",
    "data.h5_sign_status",
    "data.h5SignStatus",
    "data.contract_status",
    "data.contractStatus",
  ]);
}

export function extractPaymentSigned(response: unknown): boolean {
  const value = firstBoolean(response, ["signed", "data.signed"]);
  return value === true;
}

export function extractPayoutOrderId(response: unknown): string {
  return firstString(response, [
    "order_id",
    "orderId",
    "payout_order_id",
    "payoutOrderId",
    "data.order_id",
    "data.orderId",
    "data.payout_order_id",
    "data.payoutOrderId",
  ]);
}

export function extractPayoutAmountCents(response: unknown): number | null {
  for (const path of ["amount_cents", "data.amount_cents"]) {
    const value = valueAtPath(response, path);
    const amountCents = nonNegativeInteger(value);
    if (amountCents !== null) return amountCents;
  }
  return null;
}

function extractWithdrawalBusinessCode(response: unknown): string {
  const code = firstStringOrNumber(response, [
    "code",
    "status_code",
    "statusCode",
    "result_code",
    "resultCode",
    "err_code",
    "errCode",
    "error_code",
    "errorCode",
    "error.code",
    "error.status_code",
    "error.statusCode",
    "error.error_code",
    "error.errorCode",
    "data.code",
    "data.status_code",
    "data.statusCode",
    "data.result_code",
    "data.resultCode",
    "data.err_code",
    "data.errCode",
    "data.error_code",
    "data.errorCode",
    "data.error.code",
    "data.error.status_code",
    "data.error.statusCode",
    "data.error.error_code",
    "data.error.errorCode",
  ]);
  return code;
}

function extractWithdrawalBusinessMessage(response: unknown): string {
  return firstString(response, [
    "message",
    "msg",
    "status_message",
    "statusMessage",
    "description",
    "reason",
    "error",
    "error.message",
    "error.msg",
    "error.status_message",
    "error.statusMessage",
    "error.description",
    "error.reason",
    "data.message",
    "data.msg",
    "data.status_message",
    "data.statusMessage",
    "data.description",
    "data.reason",
    "data.error",
    "data.error.message",
    "data.error.msg",
    "data.error.status_message",
    "data.error.statusMessage",
    "data.error.description",
    "data.error.reason",
  ]);
}

function isResponseExplicitlyFailed(response: unknown): boolean {
  if (!isRecordLike(response)) return false;
  const data = responseData(response) ?? response;
  if (response.ok === false || data.ok === false) return true;
  const status = firstString(response, ["status", "data.status"]).toLowerCase();
  return ["failed", "failure", "rejected", "invalid", "error"].includes(status);
}

function withdrawalBusinessCodeFieldErrors(
  code: string,
  phase: "identity" | "bank_card",
  message: string,
): WithdrawalProfileFieldErrors {
  const text = message || withdrawalBusinessCodeMessage(code);
  switch (code) {
    case "10003":
      return { realName: text, idCard: text };
    case "10105":
      return { realName: text, idCard: text };
    case "10106":
      return { cardNo: text };
    case "10108":
      return { realName: text, idCard: text, cardNo: text };
    case "10001":
      return phase === "identity" ? { idCard: text } : { cardNo: text };
    default:
      return {};
  }
}

function withdrawalBusinessCodeMessage(code: string): string {
  switch (code) {
    case "10003":
      return "认证不通过。";
    case "10105":
      return "姓名与身份证号不匹配。";
    case "10106":
      return "身份证号与银行卡号不匹配。";
    case "10108":
      return "姓名/身份证号/银行卡号不匹配。";
    case "10001":
      return "验证不通过，请稍后重试。";
    default:
      return "信息验证失败，请检查后重新提交。";
  }
}

function hasProfileFieldErrors(errors: WithdrawalProfileFieldErrors): boolean {
  return Object.values(errors).some((value) => Boolean(value?.trim()));
}

function firstString(value: unknown, paths: string[]): string {
  for (const path of paths) {
    const item = valueAtPath(value, path);
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function firstStringOrNumber(value: unknown, paths: string[]): string {
  return stringsOrNumbersAtPaths(value, paths)[0] ?? "";
}

function stringsOrNumbersAtPaths(value: unknown, paths: string[]): string[] {
  const items: string[] = [];
  for (const path of paths) {
    const item = valueAtPath(value, path);
    if (typeof item === "string" && item.trim()) items.push(item.trim());
    if (typeof item === "number" && Number.isFinite(item)) items.push(String(item));
  }
  return items;
}

function firstBoolean(value: unknown, paths: string[]): boolean | null {
  for (const path of paths) {
    const item = valueAtPath(value, path);
    if (typeof item === "boolean") return item;
  }
  return null;
}

function firstRecord(value: unknown, paths: string[]): Record<string, unknown> | null {
  for (const path of paths) {
    const item = valueAtPath(value, path);
    if (isRecordLike(item)) return item;
  }
  return null;
}

function responseData(value: unknown): Record<string, unknown> | null {
  if (!isRecordLike(value)) return null;
  return isRecordLike(value.data) ? value.data : value;
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeActivePayout(value: unknown): WithdrawalActivePayout | null {
  if (!isRecordLike(value)) return null;
  const amountCents = nonNegativeInteger(value.amount_cents);
  const orderId = typeof value.order_id === "string" ? value.order_id.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim() : "";
  const createdAt = typeof value.created_at === "string" ? value.created_at.trim() : "";
  if (amountCents === null || !orderId || !status || !createdAt) return null;
  return {
    actionRequired: optionalString(value.action_required),
    amountCents,
    createdAt,
    currency: normalizeWithdrawalCurrency(value.currency) ?? "CNY",
    orderId,
    provider: normalizeWithdrawalProvider(value.provider) ?? "yunzhanghu",
    providerStatus: optionalString(value.provider_status),
    status,
  };
}

function activePayoutFromRecords(
  records: WithdrawalRecord[],
  provider?: WithdrawalPayoutProvider,
): WithdrawalActivePayout | null {
  const record = records.find(
    (item) => (!provider || item.provider === provider) && isWithdrawalRecordInProgress(item),
  );
  if (!record) return null;
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

function normalizeIdentityInfoStatus(profile: Record<string, unknown>): WithdrawalProfileReviewStatus {
  const explicit = normalizeProfileReviewStatus(
    firstString(profile, [
      "identity_status",
      "identityStatus",
      "identity_info_status",
      "identityInfoStatus",
      "identity_verification_status",
      "identityVerificationStatus",
      "payout_info_status",
      "payoutInfoStatus",
    ]),
  );
  if (explicit) return explicit;
  return profile.payout_info_verified === true ? "verified" : "missing";
}

function normalizeBankCardStatus(profile: Record<string, unknown>): WithdrawalProfileReviewStatus {
  const explicit = normalizeProfileReviewStatus(
    firstString(profile, [
      "bank_card_status",
      "bankCardStatus",
      "bank_card_verification_status",
      "bankCardVerificationStatus",
    ]),
  );
  if (explicit) return explicit;
  if (profile.bank_card_verified === true) return "verified";
  return profile.payout_info_verified === true ? "verified" : "missing";
}

function normalizeProfileReviewStatus(value: string): WithdrawalProfileReviewStatus | null {
  switch (value.trim().toLowerCase()) {
    case "missing":
    case "not_started":
    case "unsubmitted":
      return "missing";
    case "pending":
    case "processing":
    case "reviewing":
    case "verifying":
      return "pending";
    case "verified":
    case "approved":
    case "passed":
    case "success":
      return "verified";
    case "rejected":
    case "failed":
    case "invalid":
    case "expired":
      return "rejected";
    default:
      return null;
  }
}

function normalizeContractStatus(profile: Record<string, unknown>): WithdrawalContractStatus {
  const explicit = firstString(profile, [
    "contract_status",
    "contractStatus",
    "sign_status",
    "signStatus",
    "h5_sign_status",
    "h5SignStatus",
  ])
    .trim()
    .toLowerCase();
  switch (explicit) {
    case "not_started":
    case "signing":
    case "signed":
    case "terminated":
    case "expired":
    case "failed":
      return explicit;
    default:
      if (profile.signed === true) return "signed";
      return extractPaymentUrl(profile) ? "signing" : "not_started";
  }
}

function compactProfileFieldErrors(errors: WithdrawalProfileFieldErrors): WithdrawalProfileFieldErrors {
  return Object.fromEntries(
    Object.entries(errors).filter(([, value]) => value?.trim()),
  ) as WithdrawalProfileFieldErrors;
}

// forwarding-boundary: narrows remote error names to the public withdrawal contract.
function isWithdrawalPublicErrorName(value: string): value is WithdrawalPublicErrorName {
  return [
    "PAYOUT_PROFILE_REQUIRED",
    "PAYOUT_PROFILE_ALREADY_EXISTS",
    "ID_CARD_ALREADY_BOUND",
    "IDENTITY_VERIFICATION_FAILED",
    "BANK_CARD_VERIFICATION_FAILED",
    "SIGN_APPLICATION_IN_PROGRESS",
    "SIGN_REQUIRED",
    "NO_WITHDRAWABLE_BALANCE",
    "YZH_UNAVAILABLE",
    "PAYOUT_REQUEST_IN_PROGRESS",
    "PAYOUT_DAILY_LIMIT_EXCEEDED",
    "STRIPE_CONSENT_REQUIRED",
    "STRIPE_CONNECT_NOT_READY",
    "STRIPE_UNAVAILABLE",
    "PAYOUT_AMOUNT_LIMIT_EXCEEDED",
    "SERVICE_UNAVAILABLE",
    "ACCESS_TOKEN_INVALID",
    "SESSION_REQUIRED",
  ].includes(value);
}

function normalizePayoutOrders(value: unknown): { records: WithdrawalRecord[]; total: number } | null {
  if (value === undefined) return null;
  const data = responseData(value);
  if (!data) return null;
  const total = nonNegativeInteger(data.total);
  if (total === null || !Array.isArray(data.items)) return null;
  const records: WithdrawalRecord[] = [];
  for (const item of data.items) {
    const record = normalizeWithdrawalRecord(item);
    if (!record) return null;
    records.push(record);
  }
  return {
    total,
    records,
  };
}

export function normalizeWithdrawalRecord(value: unknown): WithdrawalRecord | null {
  if (!isRecordLike(value)) return null;
  const amountCents = nonNegativeInteger(value.amount_cents);
  const id = typeof value.order_id === "string" ? value.order_id.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim() : "";
  const createdAt = typeof value.created_at === "string" ? value.created_at.trim() : "";
  const finishedAt =
    typeof value.finished_at === "string" && value.finished_at.trim() ? value.finished_at.trim() : null;
  const failureReason = typeof value.failure_reason === "string" ? value.failure_reason.trim() : "";
  const explicitProvider = normalizeWithdrawalProvider(value.provider);
  const explicitCurrency = normalizeWithdrawalCurrency(value.currency);
  // Compatibility boundary for #768: legacy Yunzhanghu rows predate provider/currency columns.
  const provider = explicitProvider ?? (!value.provider && !value.currency ? "yunzhanghu" : null);
  const currency = explicitCurrency ?? (!value.provider && !value.currency ? "CNY" : null);
  if (amountCents === null || amountCents <= 0 || !id || !provider || !currency) return null;
  if ((provider === "stripe" && currency !== "USD") || (provider === "yunzhanghu" && currency !== "CNY")) return null;
  return {
    actionRequired: optionalString(value.action_required),
    amountCents,
    channel: optionalString(value.channel),
    currency,
    createdAt,
    failureReason,
    finishedAt,
    id,
    provider,
    providerStatus: optionalString(value.provider_status),
    status,
    updatedAt: optionalString(value.updated_at),
  };
}

function normalizeStripeConnectAccountStatus(value: unknown): StripeConnectAccountStatus | null {
  if (!isRecordLike(value)) return null;
  const accountId = requiredString(value.account_id);
  const country = requiredString(value.country);
  const defaultCurrency = requiredString(value.default_currency).toUpperCase();
  const requirementsState = requiredString(value.requirements_state);
  const currentlyDue = stringArray(value.currently_due);
  const pendingVerification = stringArray(value.pending_verification);
  const pastDue = stringArray(value.past_due);
  const requirementsErrors = normalizeStripeRequirementErrors(value.requirements_errors);
  if (
    !accountId ||
    !country ||
    !defaultCurrency ||
    !requirementsState ||
    typeof value.details_submitted !== "boolean" ||
    typeof value.payouts_enabled !== "boolean" ||
    typeof value.payout_schedule_manual !== "boolean" ||
    !currentlyDue ||
    !pendingVerification ||
    !pastDue ||
    !requirementsErrors
  )
    return null;
  return {
    accountId,
    country,
    defaultCurrency,
    detailsSubmitted: value.details_submitted,
    payoutsEnabled: value.payouts_enabled,
    payoutScheduleManual: value.payout_schedule_manual,
    requirementsState,
    currentlyDue,
    pendingVerification,
    pastDue,
    requirementsErrors,
    ...optionalProperty("externalAccountCurrency", value.external_account_currency, (item) => item.toUpperCase()),
    ...optionalProperty("externalAccountBankName", value.external_account_bank_name),
    ...optionalProperty("externalAccountLast4", value.external_account_last4),
    ...optionalProperty("externalAccountStatus", value.external_account_status),
    ...optionalProperty("lastSyncedAt", value.last_synced_at),
  };
}

function normalizeStripeRequirementErrors(value: unknown): StripeConnectRequirementError[] | null {
  if (!Array.isArray(value)) return null;
  const errors: StripeConnectRequirementError[] = [];
  for (const item of value) {
    if (!isRecordLike(item)) return null;
    const requirement = requiredString(item.requirement);
    const code = requiredString(item.code);
    if (!requirement || !code) return null;
    errors.push({ requirement, code });
  }
  return errors;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.map(requiredString);
  return strings.every(Boolean) || strings.length === 0 ? strings : null;
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalProperty<K extends string>(
  key: K,
  value: unknown,
  transform: (value: string) => string = (item) => item,
): { [P in K]?: string } {
  const normalized = optionalString(value);
  return normalized ? ({ [key]: transform(normalized) } as { [P in K]?: string }) : {};
}

function normalizeWithdrawalProvider(value: unknown): WithdrawalPayoutProvider | null {
  return value === "stripe" || value === "yunzhanghu" ? value : null;
}

function normalizeWithdrawalCurrency(value: unknown): WithdrawalCurrency | null {
  return value === "USD" || value === "CNY" ? value : null;
}
