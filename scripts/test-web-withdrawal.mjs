import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { cacheAuthSessionUser } from "../dist/server/bridge-security.js";
import { startOpenGroveServer } from "../dist/server/create-server.js";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-web-withdrawal-"));
const bundlePath = join(tempDir, "withdrawal-api.mjs");
const componentEntryPath = join(tempDir, "withdrawal-dialog-entry.tsx");
const componentBundlePath = join(tempDir, "withdrawal-dialog.cjs");
const interactionEntryPath = join(tempDir, "withdrawal-interaction-entry.tsx");
const interactionBundlePath = join(tempDir, "withdrawal-interaction.js");
const emptyOrdersResponse = { data: { items: [], page: 1, page_size: 20, total: 0 } };

try {
  await build({
    entryPoints: [join(projectRoot, "web/src/withdrawal-api.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: bundlePath,
  });
  const api = await import(pathToFileURL(bundlePath).href);
  assert.deepEqual(
    api.normalizeWithdrawalOverviewStatus(
      {
        data: {
          cash_balance_cents: 12_888,
          cash_frozen_cents: 0,
          total_cash_earned_cents: 42_890,
          total_cash_withdrawn_cents: 8_800,
        },
      },
      {
        data: {
          items: [
            {
              order_id: "order-overview-active",
              amount_cents: 12_888,
              status: "processing",
              created_at: "2026-07-20T09:30:00Z",
              finished_at: null,
              failure_reason: "",
            },
          ],
          page: 1,
          page_size: 1,
          total: 3,
        },
      },
    ),
    {
      settlement: { countryCode: "CN", provider: "yunzhanghu", currency: "CNY" },
      stripeConnect: null,
      balanceCents: 12_888,
      withdrawalCount: 3,
      totalEarningsCents: 42_890,
      frozenCents: 0,
      totalWithdrawnCents: 8_800,
      identityInfoStatus: "missing",
      bankCardStatus: "missing",
      contractStatus: "not_started",
      signingUrl: "",
      bankCardLast4: "",
      profileFieldErrors: {},
      payoutInProgress: true,
      activePayout: {
        actionRequired: "",
        amountCents: 12_888,
        createdAt: "2026-07-20T09:30:00Z",
        currency: "CNY",
        orderId: "order-overview-active",
        provider: "yunzhanghu",
        providerStatus: "",
        status: "processing",
      },
      withdrawalRecords: [
        {
          actionRequired: "",
          id: "order-overview-active",
          amountCents: 12_888,
          channel: "",
          createdAt: "2026-07-20T09:30:00Z",
          currency: "CNY",
          failureReason: "",
          finishedAt: null,
          provider: "yunzhanghu",
          providerStatus: "",
          status: "processing",
          updatedAt: "",
        },
      ],
      recordsStatus: "ready",
    },
  );
  assert.deepEqual(
    api.normalizeWithdrawalStatus(
      {
        data: {
          cash_balance_cents: 12_888,
          cash_frozen_cents: 0,
          total_cash_earned_cents: 42_890,
          total_cash_withdrawn_cents: 8_800,
        },
      },
      {
        data: {
          payout_info_verified: true,
          signed: true,
          bank_card_no: "6228888888888888888",
          sign_url: "https://pay.example.test/sign",
          payout_in_progress: false,
          active_payout: null,
        },
      },
      {
        data: {
          items: [
            {
              order_id: "order-1",
              amount_cents: 8_800,
              status: "paid",
              created_at: "2026-07-18T01:30:00Z",
              finished_at: "2026-07-18 09:30:10",
              failure_reason: "",
            },
            {
              order_id: "order-2",
              amount_cents: 5_000,
              status: "failed",
              created_at: "2026-07-17T01:30:00Z",
              finished_at: null,
              failure_reason: "收款银行卡状态异常",
            },
          ],
          page: 1,
          page_size: 20,
          total: 2,
        },
      },
    ),
    {
      settlement: { countryCode: "CN", provider: "yunzhanghu", currency: "CNY" },
      stripeConnect: null,
      balanceCents: 12_888,
      withdrawalCount: 2,
      totalEarningsCents: 42_890,
      frozenCents: 0,
      totalWithdrawnCents: 8_800,
      identityInfoStatus: "verified",
      bankCardStatus: "verified",
      contractStatus: "signed",
      signingUrl: "https://pay.example.test/sign",
      bankCardLast4: "8888",
      profileFieldErrors: {},
      payoutInProgress: false,
      activePayout: null,
      withdrawalRecords: [
        {
          actionRequired: "",
          id: "order-1",
          amountCents: 8_800,
          channel: "",
          createdAt: "2026-07-18T01:30:00Z",
          currency: "CNY",
          failureReason: "",
          finishedAt: "2026-07-18 09:30:10",
          provider: "yunzhanghu",
          providerStatus: "",
          status: "paid",
          updatedAt: "",
        },
        {
          actionRequired: "",
          id: "order-2",
          amountCents: 5_000,
          channel: "",
          createdAt: "2026-07-17T01:30:00Z",
          currency: "CNY",
          failureReason: "收款银行卡状态异常",
          finishedAt: null,
          provider: "yunzhanghu",
          providerStatus: "",
          status: "failed",
          updatedAt: "",
        },
      ],
      recordsStatus: "ready",
    },
  );
  const degradedOrdersStatus = api.normalizeWithdrawalStatus(
    {
      cash_balance_cents: 10_000,
      cash_frozen_cents: 0,
      total_cash_earned_cents: 10_000,
      total_cash_withdrawn_cents: 0,
    },
    {
      payout_info_verified: true,
      signed: true,
      payout_in_progress: true,
      active_payout: {
        order_id: "order-still-authoritative",
        amount_cents: 10_000,
        status: "processing",
        created_at: "2026-07-19T01:30:00Z",
      },
    },
    { data: { unexpected: true } },
  );
  assert.equal(degradedOrdersStatus?.balanceCents, 10_000);
  assert.equal(degradedOrdersStatus?.recordsStatus, "unavailable");
  assert.deepEqual(degradedOrdersStatus?.withdrawalRecords, []);
  assert.equal(degradedOrdersStatus?.activePayout?.orderId, "order-still-authoritative");
  assert.equal(degradedOrdersStatus?.payoutInProgress, true);
  assert.deepEqual(
    api.normalizeWithdrawalStatus(
      {
        cash_balance_cents: 10_000,
        cash_frozen_cents: 0,
        total_cash_earned_cents: 10_000,
        total_cash_withdrawn_cents: 0,
      },
      {
        payout_info_verified: true,
        signed: false,
        bank_card_no: "6222020000000000",
        payout_in_progress: true,
        active_payout: {
          order_id: "order-active",
          amount_cents: 10_000,
          status: "processing",
          created_at: "2026-07-19T01:30:00Z",
        },
      },
      emptyOrdersResponse,
    )?.activePayout,
    {
      actionRequired: "",
      orderId: "order-active",
      amountCents: 10_000,
      currency: "CNY",
      provider: "yunzhanghu",
      providerStatus: "",
      status: "processing",
      createdAt: "2026-07-19T01:30:00Z",
    },
  );
  const processingStatus = api.normalizeWithdrawalStatus(
    {
      cash_balance_cents: 0,
      cash_frozen_cents: 10_000,
      total_cash_earned_cents: 10_000,
      total_cash_withdrawn_cents: 0,
    },
    {
      payout_info_verified: true,
      signed: true,
      bank_card_no: "6222020000000000",
      payout_in_progress: true,
      active_payout: {
        order_id: "order-processing",
        amount_cents: 10_000,
        status: "processing",
        created_at: "2026-07-19T01:30:00Z",
      },
    },
    {
      data: {
        items: [
          {
            order_id: "order-processing",
            amount_cents: 10_000,
            status: "processing",
            created_at: "2026-07-19T01:30:00Z",
            finished_at: null,
            failure_reason: "",
          },
        ],
        page: 1,
        page_size: 20,
        total: 1,
      },
    },
  );
  assert.equal(processingStatus?.withdrawalCount, 1);
  assert.equal(processingStatus?.withdrawalRecords[0]?.status, "processing");
  const rejectedStatus = api.normalizeWithdrawalStatus(
    {
      cash_balance_cents: 10_000,
      cash_frozen_cents: 0,
      total_cash_earned_cents: 10_000,
      total_cash_withdrawn_cents: 0,
    },
    {
      identity_status: "rejected",
      bank_card_status: "pending",
      contract_status: "signing",
      bank_card_no: "6222020000000000",
      field_errors: {
        real_name: "姓名与身份证信息不匹配",
        phone_no: "手机号不是该银行卡预留手机号",
        bank_card_no: "银行卡号无效",
      },
    },
    emptyOrdersResponse,
  );
  assert.equal(rejectedStatus?.identityInfoStatus, "rejected");
  assert.equal(rejectedStatus?.bankCardStatus, "pending");
  assert.equal(rejectedStatus?.contractStatus, "signing");
  assert.deepEqual(rejectedStatus?.profileFieldErrors, {
    realName: "姓名与身份证信息不匹配",
    phoneNo: "手机号不是该银行卡预留手机号",
    cardNo: "银行卡号无效",
  });
  assert.equal(api.normalizeWithdrawalStatus({ ok: true, withdrawal_count: 1 }, {}, emptyOrdersResponse), null);
  assert.deepEqual(
    api.normalizeWithdrawalSettlement({
      country_code: "CN",
      payout_provider: "yunzhanghu",
      cash_currency: "CNY",
    }),
    { countryCode: "CN", provider: "yunzhanghu", currency: "CNY" },
  );
  assert.deepEqual(
    api.normalizeWithdrawalSettlement({
      data: {
        country_code: "GB",
        payout_provider: "stripe",
        cash_currency: "USD",
      },
    }),
    { countryCode: "GB", provider: "stripe", currency: "USD" },
  );
  assert.equal(
    api.normalizeWithdrawalSettlement({
      country_code: "US",
      payout_provider: "yunzhanghu",
      cash_currency: "CNY",
    }),
    null,
  );
  assert.equal(
    api.normalizeWithdrawalSettlement({
      country_code: "CN",
      payout_provider: "stripe",
      cash_currency: "USD",
    }),
    null,
  );
  assert.deepEqual(
    api.normalizeStripeConnectStatus({
      data: {
        agreement_version: "2026-08-19",
        consent_accepted: true,
        ready_for_payout: false,
        missing_requirements: ["account_verification_pending"],
        account: {
          account_id: "acct_safe_summary",
          country: "GB",
          default_currency: "USD",
          details_submitted: true,
          payouts_enabled: false,
          payout_schedule_manual: true,
          requirements_state: "pending_verification",
          currently_due: [],
          pending_verification: ["individual.verification.document"],
          past_due: [],
          requirements_errors: [],
          external_account_currency: "USD",
          external_account_bank_name: "EXAMPLE BANK",
          external_account_last4: "6789",
          external_account_status: "verified",
          last_synced_at: "2026-08-20T08:00:00Z",
        },
      },
    }),
    {
      consentAccepted: true,
      readyForPayout: false,
      missingRequirements: ["account_verification_pending"],
      account: {
        accountId: "acct_safe_summary",
        country: "GB",
        defaultCurrency: "USD",
        detailsSubmitted: true,
        payoutsEnabled: false,
        payoutScheduleManual: true,
        requirementsState: "pending_verification",
        currentlyDue: [],
        pendingVerification: ["individual.verification.document"],
        pastDue: [],
        requirementsErrors: [],
        externalAccountCurrency: "USD",
        externalAccountBankName: "EXAMPLE BANK",
        externalAccountLast4: "6789",
        externalAccountStatus: "verified",
        lastSyncedAt: "2026-08-20T08:00:00Z",
      },
    },
  );
  assert.deepEqual(
    api.normalizeStripeConnectStatus({
      data: {
        consent_accepted: true,
        ready_for_payout: true,
        missing_requirements: ["not_a_public_requirement"],
      },
    }),
    {
      consentAccepted: true,
      readyForPayout: true,
      missingRequirements: ["not_a_public_requirement"],
    },
  );
  assert.deepEqual(
    api.normalizeWithdrawalRecord({
      order_id: "stripe-order-1",
      provider: "stripe",
      currency: "USD",
      channel: "bank_account",
      amount_cents: 10_000,
      status: "hanging",
      provider_status: "payout_action_required",
      action_required: "update_bank_account",
      failure_reason: "bank_account_closed",
      created_at: "2026-08-20T08:01:00Z",
      updated_at: "2026-08-20T08:02:00Z",
    }),
    {
      id: "stripe-order-1",
      provider: "stripe",
      currency: "USD",
      channel: "bank_account",
      amountCents: 10_000,
      status: "hanging",
      providerStatus: "payout_action_required",
      actionRequired: "update_bank_account",
      failureReason: "bank_account_closed",
      createdAt: "2026-08-20T08:01:00Z",
      updatedAt: "2026-08-20T08:02:00Z",
      finishedAt: null,
    },
  );
  assert.equal(api.extractStripeHostedOnboardingUrl({ data: { url: "http://connect.stripe.com/setup/demo" } }), "");
  assert.equal(api.extractStripeHostedOnboardingUrl({ data: { url: "https://stripe.example.test/setup/demo" } }), "");
  assert.equal(
    api.extractStripeHostedOnboardingUrl({ data: { url: "https://connect.stripe.com/setup/demo" } }),
    "https://connect.stripe.com/setup/demo",
  );
  assert.deepEqual(
    api.normalizeWithdrawalContractState({
      data: {
        signed: false,
        sign_url: "https://pay.example.test/resume-signing",
      },
    }),
    {
      contractStatus: "signing",
      signingUrl: "https://pay.example.test/resume-signing",
    },
  );
  assert.equal(api.extractPaymentUrl({ signing_url: "http://insecure.example.test/sign" }), "");
  assert.equal(api.extractPaymentUrl({ signing_url: "javascript:alert(1)" }), "");
  assert.equal(api.extractPaymentSigned({ data: { signed: true } }), true);
  assert.equal(api.extractPaymentStatus({ data: { contract_status: "failed" } }), "failed");
  assert.equal(
    api.normalizeWithdrawalStatus(
      {
        cash_balance_cents: 10_000,
        cash_frozen_cents: 0,
        total_cash_earned_cents: 10_000,
        total_cash_withdrawn_cents: 0,
      },
      {
        payout_info_verified: true,
        signed: false,
        sign_url: "https://pay.example.test/resume-signing",
        bank_card_no: "6222020000000000",
      },
      emptyOrdersResponse,
    )?.contractStatus,
    "signing",
  );
  assert.equal(api.extractPayoutAmountCents({ data: { amount_cents: 10_000 } }), 10_000);
  assert.deepEqual(
    api.extractWithdrawalProfileFieldErrors({
      data: {
        fieldErrors: {
          idCard: "身份证号格式不正确",
          cardNo: "银行卡号无效",
        },
      },
    }),
    {
      idCard: "身份证号格式不正确",
      cardNo: "银行卡号无效",
    },
  );
  assert.equal(api.extractWithdrawalVerificationFailure({ code: "0000", message: "操作成功" }, "identity"), null);
  assert.deepEqual(api.extractWithdrawalVerificationFailure({ code: "10003", message: "认证不通过" }, "identity"), {
    fieldErrors: {
      realName: "认证不通过",
      idCard: "认证不通过",
    },
    message: "认证不通过",
  });
  assert.deepEqual(
    api.extractWithdrawalVerificationFailure({ code: "10106", message: "身份证号与银行卡号不匹配" }, "bank_card"),
    {
      fieldErrors: {
        cardNo: "身份证号与银行卡号不匹配",
      },
      message: "身份证号与银行卡号不匹配",
    },
  );
  assert.deepEqual(
    api.extractWithdrawalVerificationFailure(
      { data: { status_code: "10105", statusMessage: "姓名与身份证号不匹配" } },
      "bank_card",
    ),
    {
      fieldErrors: {
        realName: "姓名与身份证号不匹配",
        idCard: "姓名与身份证号不匹配",
      },
      message: "姓名与身份证号不匹配",
    },
  );
  assert.deepEqual(
    api.extractWithdrawalVerificationFailure({ code: "10108", message: "姓名/身份证号/银行卡号不匹配" }, "bank_card"),
    {
      fieldErrors: {
        realName: "姓名/身份证号/银行卡号不匹配",
        idCard: "姓名/身份证号/银行卡号不匹配",
        cardNo: "姓名/身份证号/银行卡号不匹配",
      },
      message: "姓名/身份证号/银行卡号不匹配",
    },
  );
  assert.deepEqual(
    api.extractWithdrawalVerificationFailure({ code: "10001", message: "验证不通过，请稍后重试" }, "identity"),
    {
      fieldErrors: {
        idCard: "验证不通过，请稍后重试",
      },
      message: "验证不通过，请稍后重试",
    },
  );
  assert.equal(
    api.withdrawalProfileSubmissionErrorMessage(new Error("PAYOUT_PROFILE_ALREADY_EXISTS")),
    "当前身份信息已存在",
  );
  assert.equal(
    api.withdrawalProfileSubmissionErrorMessage(new Error("ID_CARD_ALREADY_BOUND")),
    "当前身份证已被使用，请联系产品处理",
  );
  assert.equal(
    api.withdrawalProfileSubmissionErrorMessage(new Error("IDENTITY_VERIFICATION_FAILED")),
    "请核对姓名和身份证号。",
  );
  assert.equal(
    api.withdrawalProfileSubmissionErrorMessage({ error_name: "BANK_CARD_VERIFICATION_FAILED" }),
    "请核对银行卡和姓名、身份证、手机号。",
  );
  assert.equal(api.withdrawalProfileSubmissionErrorMessage({ error: "YZH_UNAVAILABLE" }), "请稍后重试。");
  assert.equal(
    api.withdrawalProfileSubmissionErrorMessage({
      error: { code: 101305, message: "银行卡三要素验证失败", request_id: "req-profile" },
    }),
    "请核对银行卡和姓名、身份证、手机号。",
  );
  assert.equal(
    api.withdrawalSignApplicationErrorMessage(new Error("SIGN_APPLICATION_IN_PROGRESS")),
    "已有签约申请处理中，请等当前签约流程结束后重试",
  );
  assert.equal(api.withdrawalSignApplicationErrorMessage({ error_name: "YZH_UNAVAILABLE" }), "请稍后重试。");
  assert.equal(
    api.withdrawalSignApplicationErrorMessage({ error: { code: 101306, message: "签约申请正在处理中" } }),
    "已有签约申请处理中，请等当前签约流程结束后重试",
  );
  assert.equal(
    api.withdrawalPayoutSubmissionErrorMessage(new Error("PAYOUT_PROFILE_REQUIRED")),
    "请先完成提现信息填写",
  );
  assert.equal(api.withdrawalPayoutSubmissionErrorMessage(new Error("SIGN_REQUIRED")), "请先完成劳动者签约");
  assert.equal(api.withdrawalPayoutSubmissionErrorMessage(new Error("NO_WITHDRAWABLE_BALANCE")), "当前没有可提现余额");
  assert.equal(api.withdrawalPayoutSubmissionErrorMessage(new Error("SERVICE_UNAVAILABLE")), "请稍后重试。");
  assert.equal(
    api.withdrawalPayoutSubmissionErrorMessage({
      error: { message: "SIGN_REQUIRED", code: 101307, request_id: "req-sign" },
    }),
    "请先完成劳动者签约",
  );
  assert.equal(
    api.withdrawalPayoutSubmissionErrorMessage({ error: { code: 101301, message: "资料不存在" } }),
    "请先完成提现信息填写",
  );
  assert.equal(
    api.withdrawalPayoutSubmissionErrorMessage({ error: { code: 101308, message: "余额不足" } }),
    "当前没有可提现余额",
  );
  assert.equal(api.extractWithdrawalPublicErrorName({ error: { code: 101310 } }), "PAYOUT_REQUEST_IN_PROGRESS");
  assert.equal(api.extractWithdrawalPublicErrorName({ error: { code: 101311 } }), "PAYOUT_DAILY_LIMIT_EXCEEDED");
  assert.equal(api.extractWithdrawalPublicErrorName({ error: { code: 101312 } }), "STRIPE_CONSENT_REQUIRED");
  assert.equal(api.extractWithdrawalPublicErrorName({ error: { code: 101313 } }), "STRIPE_CONNECT_NOT_READY");
  assert.equal(api.extractWithdrawalPublicErrorName({ error: { code: 101314 } }), "STRIPE_UNAVAILABLE");
  assert.equal(api.extractWithdrawalPublicErrorName({ error: { code: 101315 } }), "PAYOUT_AMOUNT_LIMIT_EXCEEDED");
  assert.equal(api.withdrawalPayoutSubmissionErrorMessage({ error: { code: 101311 } }), "今天已提交过提现，请明天再试");
  assert.equal(api.withdrawalPayoutSubmissionErrorMessage({ error: { code: 101315 } }), "单次提现上限为 $1,000.00");
  assert.equal(
    api.withdrawalPayoutSubmissionErrorMessage({ error: { code: 100004, message: "temporarily unavailable" } }),
    "请稍后重试。",
  );
  const bridgeWrappedServiceError = new Error("temporarily unavailable");
  bridgeWrappedServiceError.code = "100004";
  assert.equal(api.withdrawalPayoutSubmissionErrorMessage(bridgeWrappedServiceError), "请稍后重试。");
  assert.equal(api.withdrawalOrderSyncErrorMessage(new Error("SERVICE_UNAVAILABLE")), "请稍后重试。");
  assert.equal(
    api.withdrawalOrderSyncErrorMessage({ data: { error: { code: 100004, message: "temporarily unavailable" } } }),
    "请稍后重试。",
  );
  assert.equal(api.isWithdrawalAuthExpiredError(new Error("ACCESS_TOKEN_INVALID")), true);
  assert.equal(api.isWithdrawalAuthExpiredError(new Error("session_required")), true);
  assert.equal(api.isWithdrawalAuthExpiredError({ error: "session_required" }), true);
  assert.equal(api.isWithdrawalAuthExpiredError(new Error("SERVICE_UNAVAILABLE")), false);
  const payoutRecord = (status, overrides = {}) => ({
    actionRequired: "",
    amountCents: 1_000,
    createdAt: "2026-07-20T01:30:00Z",
    currency: "CNY",
    failureReason: "",
    finishedAt: null,
    id: `record-${status}`,
    provider: "yunzhanghu",
    providerStatus: "",
    status,
    ...overrides,
  });
  for (const status of ["created", "submitting", "processing", "hanging", "review_required"]) {
    assert.equal(api.isWithdrawalRecordInProgress(payoutRecord(status)), true);
    assert.equal(api.withdrawalRecordStatusLabel(payoutRecord(status)), "提现中");
  }
  assert.equal(api.isWithdrawalRecordInProgress(payoutRecord("paid")), false);
  assert.equal(api.withdrawalRecordStatusLabel(payoutRecord("paid", { finishedAt: "2026-07-20 09:30:10" })), "已到账");
  assert.equal(api.withdrawalRecordStatusLabel(payoutRecord("paid")), "已到账");
  assert.equal(
    api.withdrawalRecordStatusLabel(payoutRecord("failed", { failureReason: "收款银行卡状态异常" })),
    "提现失败",
  );
  assert.equal(api.withdrawalRecordStatusLabel(payoutRecord("failed")), "提现失败");
  assert.equal(api.withdrawalRecordStatusLabel(payoutRecord("returned")), "提现失败");
  assert.equal(api.withdrawalRecordStatusLabel(payoutRecord("cancelled")), "提现失败");
  assert.equal(api.withdrawalRecordStatusLabel(payoutRecord("invalid")), "提现失败");
  assert.equal(
    api.withdrawalRecordStatusLabel(
      payoutRecord("paid", {
        provider: "stripe",
        providerStatus: "payout_pending",
      }),
    ),
    "已到账",
  );
  assert.equal(
    api.withdrawalRecordStatusDetail(payoutRecord("failed", { failureReason: "收款银行卡状态异常" })),
    "收款银行卡状态异常",
  );
  assert.equal(api.withdrawalRecordStatusDetail(payoutRecord("failed")), "提现失败。");
  assert.equal(api.withdrawalRecordStatusDetail(payoutRecord("returned")), "提现已退回，金额已退回余额。");
  assert.equal(api.withdrawalRecordStatusDetail(payoutRecord("cancelled")), "提现已被取消，金额退回余额。");
  assert.equal(api.withdrawalRecordStatusDetail(payoutRecord("invalid")), "提现订单无效。");

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const apiCalls = [];
  let settlementMode = "stripe";
  let ordersResponse = emptyOrdersResponse;
  try {
    globalThis.localStorage = { getItem: () => null };
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url);
      apiCalls.push({ path, init });
      if (path === "/v1/users/me")
        return Response.json({
          data: {
            country_code: settlementMode === "stripe" ? "GB" : "CN",
            payout_provider: settlementMode === "stripe" ? "stripe" : "yunzhanghu",
            cash_currency: settlementMode === "stripe" ? "USD" : "CNY",
            cash_balance_cents: 10_000,
            cash_frozen_cents: 0,
            total_cash_earned_cents: 10_000,
            total_cash_withdrawn_cents: 0,
          },
        });
      if (path === "/v1/stripe-connect/status" || path === "/v1/stripe-connect/sync")
        return Response.json({
          data: {
            agreement_version: "2026-08-19",
            consent_accepted: true,
            ready_for_payout: true,
            missing_requirements: [],
          },
        });
      if (path === "/v1/payment/payout-profile/status")
        return Response.json({
          data: {
            payout_info_verified: true,
            signed: true,
            bank_card_no: "6222020000008888",
            payout_in_progress: false,
          },
        });
      if (path.startsWith("/v1/payout-orders?")) return Response.json(ordersResponse);
      if (path === "/v1/stripe-connect/tax-onboarding-links")
        return Response.json({ data: { url: "https://connect.stripe.com/setup/demo" } });
      return Response.json({ error: "unexpected_test_route" }, { status: 404 });
    };
    const stripeApiStatus = await api.readWithdrawalStatus();
    assert.equal(stripeApiStatus.settlement.provider, "stripe");
    assert.equal(stripeApiStatus.stripeConnect.readyForPayout, true);
    assert.equal(
      apiCalls.some(({ path }) => path === "/v1/stripe-connect/status"),
      true,
    );
    assert.equal(
      apiCalls.some(({ path }) => path === "/v1/payment/payout-profile/status"),
      false,
    );
    assert.equal(
      apiCalls.some(({ path }) => path === "/v1/payout-orders?page=1&page_size=20"),
      true,
    );
    ordersResponse = {
      data: {
        items: [
          {
            order_id: "valid-order",
            provider: "stripe",
            currency: "USD",
            amount_cents: 10_000,
            status: "processing",
            provider_status: "payout_pending",
            created_at: "2026-08-20T08:01:00Z",
          },
          {
            order_id: "invalid-order",
            provider: "stripe",
            currency: "CNY",
            amount_cents: 10_000,
            status: "processing",
            provider_status: "payout_pending",
            created_at: "2026-08-20T08:02:00Z",
          },
        ],
        page: 1,
        page_size: 20,
        total: 2,
      },
    };
    await assert.rejects(
      () => api.readWithdrawalRecordsPage(1, 20),
      /withdrawal_records_invalid/,
      "a malformed financial record must reject the page instead of silently shrinking it",
    );
    ordersResponse = emptyOrdersResponse;
    await api.createStripeOnboardingLink();
    await api.syncStripeConnectStatus();
    assert.equal(
      apiCalls.some(({ path }) => path === "/v1/stripe-connect/consents"),
      false,
      "the client must not accept the Story Seed creator agreement through the legacy Stripe consent endpoint",
    );
    const onboardingCall = apiCalls.find(({ path }) => path === "/v1/stripe-connect/tax-onboarding-links");
    assert.equal(onboardingCall.init.body, undefined);
    assert.deepEqual(onboardingCall.init.headers, {});
    const syncCall = apiCalls.find(({ path }) => path === "/v1/stripe-connect/sync");
    assert.equal(syncCall.init.body, undefined);
    assert.deepEqual(syncCall.init.headers, {});
    settlementMode = "domestic";
    apiCalls.length = 0;
    const domesticApiStatus = await api.readWithdrawalStatus();
    assert.equal(domesticApiStatus.settlement.provider, "yunzhanghu");
    assert.equal(
      apiCalls.some(({ path }) => path === "/v1/payment/payout-profile/status"),
      true,
    );
    assert.equal(
      apiCalls.some(({ path }) => path === "/v1/stripe-connect/status"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }

  await writeFile(
    componentEntryPath,
    `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WithdrawalDialogContent } from ${JSON.stringify(join(projectRoot, "web/src/components/sidebar/app-navigation.tsx"))};
import styles from ${JSON.stringify(join(projectRoot, "web/src/components/sidebar/app-navigation.module.css"))};
import ${JSON.stringify(join(projectRoot, "web/src/styles/tokens.css"))};
import ${JSON.stringify(join(projectRoot, "web/src/styles/reset.css"))};

const baseStatus = {
  settlement: { countryCode: "CN", provider: "yunzhanghu", currency: "CNY" },
  stripeConnect: null,
  balanceCents: 0,
  withdrawalCount: 0,
  totalEarningsCents: 0,
  frozenCents: 0,
  totalWithdrawnCents: 0,
  identityInfoStatus: "verified",
  bankCardStatus: "verified",
  contractStatus: "signed",
  signingUrl: "",
  bankCardLast4: "8888",
  profileFieldErrors: {},
  payoutInProgress: false,
  activePayout: null,
  withdrawalRecords: [],
  recordsStatus: "ready",
};

const baseProps = {
  onAuthExpired() {},
  onRuntimePatch() {},
  onRecordsLoadMore() {},
  onRecordsOpen() {},
  onContractStateChange() {},
  onStatusChange() {},
  onStepChange() {},
  onToast() {},
  onWithdrawalSuccessComplete() {},
  latestPayoutNotice: null,
  runtime: { error: "", pendingAction: null, signingUrl: "" },
};

function renderWithdrawalDialog(step, title, status, runtime = baseProps.runtime) {
  return renderToStaticMarkup(<div className={\`modal-card \${styles.withdrawalDialog}\`} data-step={step}>
    <div className={styles.withdrawalDialogHeader}>
      <div className={styles.withdrawalDialogHeaderLeft}>
        <h2 className="modal-title">{title}</h2>
      </div>
    </div>
    <WithdrawalDialogContent
      {...baseProps}
      runtime={runtime}
      step={step}
      status={status}
      recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
    />
  </div>);
}

export function renderRecordsFailure() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="records"
    status={baseStatus}
    recordsPage={{ error: "service unavailable", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

export function renderOverview() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="overview"
    status={{ ...baseStatus, balanceCents: 12_345, totalEarningsCents: 45_678, withdrawalCount: 2 }}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 1, pageSize: 20, records: [], total: 2 }}
  />);
}

export function renderIdentity() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="identity"
    status={{ ...baseStatus, identityInfoStatus: "missing", bankCardStatus: "missing", contractStatus: "not_started" }}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

export function renderIdentityDialog() {
  return renderWithdrawalDialog(
    "identity",
    "Withdrawal details",
    { ...baseStatus, identityInfoStatus: "missing", bankCardStatus: "missing", contractStatus: "not_started" },
  );
}

export function renderIdentitySuccess() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="identity_success"
    status={{ ...baseStatus, contractStatus: "not_started" }}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

export function renderResumableSigning() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="contract"
    status={{ ...baseStatus, contractStatus: "signing", signingUrl: "https://pay.example.test/resume-signing" }}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

export function renderResumableSigningDialog() {
  return renderWithdrawalDialog(
    "contract",
    "Signing",
    { ...baseStatus, contractStatus: "signing", signingUrl: "https://pay.example.test/resume-signing" },
  );
}

export function renderConfirm() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="confirm"
    status={{ ...baseStatus, balanceCents: 12_345 }}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

export function renderConfirmDialog() {
  return renderWithdrawalDialog(
    "confirm",
    "Confirm withdrawal",
    { ...stripeStatus, balanceCents: 12_345 },
    { error: "The receiving account status changed. Review the message and retry this withdrawal.", pendingAction: null, signingUrl: "" },
  );
}

export function renderRecords() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="records"
    status={{ ...baseStatus, withdrawalCount: 5 }}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 1, pageSize: 20, records: [{
      actionRequired: "",
      id: "payout-1",
      amountCents: 12_345,
      channel: "bank_card",
      currency: "CNY",
      provider: "yunzhanghu",
      providerStatus: "",
      status: "paid",
      createdAt: "2026-07-20T09:30:10Z",
      updatedAt: "2026-07-20T10:30:10Z",
      finishedAt: "2026-07-20T10:30:10Z",
      failureReason: "",
    }, {
      actionRequired: "",
      id: "payout-2",
      amountCents: 6_789,
      channel: "bank_card",
      currency: "CNY",
      provider: "yunzhanghu",
      providerStatus: "",
      status: "failed",
      createdAt: "2026-07-21T09:30:10Z",
      updatedAt: "2026-07-21T10:30:10Z",
      finishedAt: "2026-07-21T10:30:10Z",
      failureReason: "收款银行卡状态异常",
    }, {
      actionRequired: "",
      id: "payout-3",
      amountCents: 2_468,
      channel: "bank_card",
      currency: "CNY",
      provider: "yunzhanghu",
      providerStatus: "",
      status: "failed",
      createdAt: "2026-07-22T09:30:10Z",
      updatedAt: "2026-07-22T10:30:10Z",
      finishedAt: "2026-07-22T10:30:10Z",
      failureReason: "App 视觉评审 failed to validate recipient",
    }, {
      actionRequired: "",
      id: "payout-4",
      amountCents: 1_234,
      channel: "bank_card",
      currency: "CNY",
      provider: "yunzhanghu",
      providerStatus: "",
      status: "failed",
      createdAt: "2026-07-23T09:30:10Z",
      updatedAt: "2026-07-23T10:30:10Z",
      finishedAt: "2026-07-23T10:30:10Z",
      failureReason: "",
    }, {
      id: "stripe-payout-5",
      provider: "stripe",
      currency: "USD",
      channel: "bank_account",
      amountCents: 10_000,
      status: "hanging",
      providerStatus: "payout_action_required",
      actionRequired: "update_bank_account",
      createdAt: "2026-08-20T08:01:00Z",
      updatedAt: "2026-08-20T08:02:00Z",
      finishedAt: null,
      failureReason: "raw_stripe_failure_must_not_render",
    }], total: 5 }}
  />);
}

export function renderSuccess() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="success"
    status={baseStatus}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

const stripeStatus = {
  ...baseStatus,
  settlement: { countryCode: "GB", provider: "stripe", currency: "USD" },
  stripeConnect: {
    consentAccepted: false,
    readyForPayout: false,
    missingRequirements: ["consent", "connected_account"],
  },
  contractStatus: "not_started",
  identityInfoStatus: "missing",
  bankCardStatus: "missing",
};

export function renderStripeConsent() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="stripe_consent"
    status={stripeStatus}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

export function renderStripeConsentDialog() {
  return renderWithdrawalDialog("stripe_consent", "Creator agreement", stripeStatus);
}

export function renderStripeSetup() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="stripe_setup"
    status={{ ...stripeStatus, stripeConnect: { ...stripeStatus.stripeConnect, consentAccepted: true, missingRequirements: ["connected_account"] } }}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

export function renderStripeSetupDialog() {
  return renderWithdrawalDialog(
    "stripe_setup",
    "Set up Stripe payouts",
    { ...stripeStatus, stripeConnect: { ...stripeStatus.stripeConnect, consentAccepted: true, missingRequirements: ["connected_account"] } },
    { error: "Stripe still needs one receiving-account requirement. Continue setup to finish it.", pendingAction: null, signingUrl: "" },
  );
}

export function renderStripeReview() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="stripe_review"
    status={{ ...stripeStatus, stripeConnect: { ...stripeStatus.stripeConnect, consentAccepted: true, missingRequirements: ["account_verification_pending"] } }}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

export function renderStripeProgress() {
  return renderToStaticMarkup(<WithdrawalDialogContent
    {...baseProps}
    step="stripe_progress"
    status={{ ...stripeStatus, balanceCents: 0, frozenCents: 10_000, payoutInProgress: true, activePayout: {
      actionRequired: "update_bank_account",
      amountCents: 10_000,
      createdAt: "2026-08-20T08:01:00Z",
      currency: "USD",
      orderId: "stripe-order-action",
      provider: "stripe",
      providerStatus: "payout_action_required",
      status: "hanging",
    } }}
    recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
  />);
}

export function renderStripeProgressDialog() {
  return renderWithdrawalDialog(
    "stripe_progress",
    "Payout progress",
    { ...stripeStatus, balanceCents: 0, frozenCents: 100, payoutInProgress: true, activePayout: {
        actionRequired: "",
        amountCents: 100,
        createdAt: "2026-08-20T08:01:00Z",
        currency: "USD",
        orderId: "stripe-order-processing",
        provider: "stripe",
        providerStatus: "payout_pending",
        status: "processing",
      } },
    { error: "The latest bank update has not arrived yet. Refresh again later.", pendingAction: null, signingUrl: "" },
  );
}
`,
    "utf8",
  );
  const componentBuild = await build({
    entryPoints: [componentEntryPath],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: componentBundlePath,
    loader: { ".css": "local-css" },
    nodePaths: [join(projectRoot, "node_modules")],
    metafile: true,
  });
  const component = await import(pathToFileURL(componentBundlePath).href);
  const componentStyleOutput = Object.keys(componentBuild.metafile.outputs).find((output) => output.endsWith(".css"));
  assert.ok(componentStyleOutput, "withdrawal component build must emit its stylesheet");
  const withdrawalStylesheet = [
    await readFile(resolve(projectRoot, "web/src/styles/tokens.css"), "utf8"),
    await readFile(resolve(projectRoot, "web/src/components/ui/dialog.css"), "utf8"),
    await readFile(resolve(componentStyleOutput), "utf8"),
  ].join("\n");
  const recordsFailureMarkup = component.renderRecordsFailure();
  assert.match(recordsFailureMarkup, /Failed to load withdrawal history/);
  assert.match(recordsFailureMarkup, />Retry</);
  assert.doesNotMatch(recordsFailureMarkup, /No withdrawals yet/);
  const overviewMarkup = component.renderOverview();
  assert.match(overviewMarkup, /Current balance/);
  assert.match(overviewMarkup, /Withdraw all/);
  assert.match(overviewMarkup, /Total earnings/);
  assert.match(overviewMarkup, /Withdrawal history/);
  const identityMarkup = component.renderIdentity();
  assert.match(identityMarkup, /Withdrawal details form/);
  assert.match(identityMarkup, />Name</);
  assert.match(identityMarkup, /ID number/);
  assert.match(identityMarkup, /Phone number/);
  assert.match(identityMarkup, /Bank card/);
  await assertWithdrawalActionLayout(component.renderIdentityDialog(), withdrawalStylesheet, {
    step: "identity",
    ariaLabel: "Withdrawal details form",
    buttonText: "Submit",
    fixtureName: "withdrawal identity form",
  });
  const identitySuccessMarkup = component.renderIdentitySuccess();
  assert.match(identitySuccessMarkup, /Details submitted/);
  assert.match(identitySuccessMarkup, /Start signing/);
  const resumableSigningMarkup = component.renderResumableSigning();
  assert.match(resumableSigningMarkup, /Signing QR code/);
  assert.match(resumableSigningMarkup, /Open in browser/);
  await assertWithdrawalActionLayout(component.renderResumableSigningDialog(), withdrawalStylesheet, {
    step: "contract",
    ariaLabel: "Signing",
    buttonText: "I have completed signing",
    fixtureName: "withdrawal signing",
  });
  const confirmMarkup = component.renderConfirm();
  assert.match(confirmMarkup, /This withdrawal/);
  assert.match(confirmMarkup, /Receiving bank card/);
  assert.match(confirmMarkup, /Confirm withdrawal/);
  const recordsMarkup = component.renderRecords();
  assert.match(recordsMarkup, /Withdrawal time/);
  assert.match(recordsMarkup, />Amount</);
  assert.match(recordsMarkup, />Status</);
  assert.match(recordsMarkup, />Paid</);
  assert.match(recordsMarkup, /The withdrawal failed/);
  assert.match(recordsMarkup, /收款银行卡状态异常/);
  assert.match(recordsMarkup, /App 视觉评审 failed to validate recipient/);
  assert.match(recordsMarkup, /\$100\.00/);
  assert.match(recordsMarkup, /Receiving account needs an update/);
  assert.doesNotMatch(recordsMarkup, /raw_stripe_failure_must_not_render/);
  const successMarkup = component.renderSuccess();
  assert.match(successMarkup, /Withdrawal request submitted/);
  assert.match(successMarkup, />Done</);
  const stripeConsentMarkup = component.renderStripeConsent();
  assert.match(stripeConsentMarkup, /Complete signing in Story Seed first/);
  assert.match(stripeConsentMarkup, /Check signing status/);
  assert.doesNotMatch(stripeConsentMarkup, /Agreement version|Agree and continue/);
  assert.doesNotMatch(stripeConsentMarkup, /Withdrawal details form/);
  await assertWithdrawalActionLayout(component.renderConfirmDialog(), withdrawalStylesheet, {
    step: "confirm",
    ariaLabel: "Confirm withdrawal",
    buttonText: "Confirm withdrawal",
    fixtureName: "withdrawal confirmation",
  });
  await assertStripeConsentLayout(component.renderStripeConsentDialog(), withdrawalStylesheet);
  const stripeSetupMarkup = component.renderStripeSetup();
  assert.match(stripeSetupMarkup, /Continue to Stripe/);
  assert.match(stripeSetupMarkup, /system browser/);
  await assertWithdrawalActionLayout(component.renderStripeSetupDialog(), withdrawalStylesheet, {
    step: "stripe_setup",
    ariaLabel: "Set up Stripe payouts",
    buttonText: "Continue to Stripe",
    fixtureName: "Stripe setup",
  });
  const stripeReviewMarkup = component.renderStripeReview();
  assert.match(stripeReviewMarkup, /under review/);
  assert.match(stripeReviewMarkup, /Check status/);
  const stripeProgressMarkup = component.renderStripeProgress();
  assert.match(stripeProgressMarkup, /\$100\.00/);
  assert.match(stripeProgressMarkup, /Receiving account needs an update/);
  assert.match(stripeProgressMarkup, /amount is still frozen/);
  assert.match(stripeProgressMarkup, /Update receiving account/);
  await assertWithdrawalActionLayout(component.renderStripeProgressDialog(), withdrawalStylesheet, {
    step: "stripe_progress",
    ariaLabel: "Payout progress",
    buttonText: "Refresh",
    fixtureName: "Stripe progress",
  });
  await writeFile(interactionEntryPath, withdrawalInteractionEntrySource(), "utf8");
  await build({
    entryPoints: [interactionEntryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    outfile: interactionBundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    plugins: [cssStubPlugin()],
  });
  await assertStripeWithdrawalInteractions(await readFile(interactionBundlePath, "utf8"));
  await assertLoopbackOriginIsolation(tempDir);
  console.log("web-withdrawal-harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function assertStripeConsentLayout(markup, stylesheet) {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 840 } });
    const page = await context.newPage();
    for (const viewport of [
      { width: 1200, height: 840 },
      { width: 900, height: 600 },
      { width: 600, height: 420 },
      { width: 1200, height: 360 },
    ]) {
      await page.setViewportSize(viewport);
      await page.setContent(`<!doctype html>
        <html lang="zh-CN">
          <head>
            <style>${stylesheet}</style>
            <style>
              html, body { width: 100%; height: 100%; margin: 0; }
              body { display: grid; place-items: center; background: #111; }
            </style>
          </head>
          <body>${markup}</body>
        </html>`);
      const layout = await page.evaluate(() => {
        const dialog = document.querySelector('[data-step="stripe_consent"]');
        const contract = dialog?.querySelector('[aria-label="Creator agreement"]');
        const shell = contract?.parentElement;
        const heading = contract?.querySelector("h3");
        const copy = contract?.querySelector("p");
        const button = dialog?.querySelector(".primary-button");
        if (
          !(dialog instanceof HTMLElement) ||
          !(shell instanceof HTMLElement) ||
          !(button instanceof HTMLElement) ||
          !(heading instanceof HTMLElement) ||
          !(copy instanceof HTMLElement)
        ) {
          return null;
        }
        heading.textContent = "请先到故事种子完成签约";
        copy.textContent = "打开故事种子，按页面提示完成创作者协议签约。签约完成后，返回这里检查状态。";
        button.textContent = "检查签约状态";
        const dialogRect = dialog.getBoundingClientRect();
        const shellRect = shell.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(
          buttonRect.left + buttonRect.width / 2,
          buttonRect.top + buttonRect.height / 2,
        );
        return {
          buttonBottom: buttonRect.bottom,
          buttonHeight: buttonRect.height,
          buttonLeft: buttonRect.left,
          buttonRight: buttonRect.right,
          buttonTop: buttonRect.top,
          dialogBottom: dialogRect.bottom,
          hitTargetIsButton: hitTarget === button || button.contains(hitTarget),
          shellBottom: shellRect.bottom,
          shellLeft: shellRect.left,
          shellRight: shellRect.right,
          shellTop: shellRect.top,
        };
      });
      const evidence = JSON.stringify({ viewport, layout });
      assert.ok(layout, `Stripe consent layout fixture must render the agreement action: ${evidence}`);
      assert.ok(layout.buttonHeight >= 40, `Stripe consent action must keep its full height: ${evidence}`);
      assert.ok(
        layout.buttonTop >= layout.shellTop &&
          layout.buttonBottom <= layout.shellBottom &&
          layout.buttonLeft >= layout.shellLeft &&
          layout.buttonRight <= layout.shellRight,
        `Stripe consent action must be fully visible inside the dialog content: ${evidence}`,
      );
      assert.ok(
        layout.buttonBottom < layout.dialogBottom,
        `Stripe consent action must not overlap the dialog edge: ${evidence}`,
      );
      assert.equal(layout.hitTargetIsButton, true, `Stripe consent action center must remain clickable: ${evidence}`);
    }
  } finally {
    await browser.close();
  }
}

async function assertWithdrawalActionLayout(markup, stylesheet, fixture) {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1202, height: 722 } });
    const page = await context.newPage();
    for (const viewport of fixture.viewports ?? [
      { width: 1202, height: 722 },
      { width: 900, height: 420 },
      { width: 600, height: 360 },
      { width: 1200, height: 360 },
    ]) {
      await page.setViewportSize(viewport);
      await page.setContent(`<!doctype html>
        <html lang="en">
          <head>
            <style>${stylesheet}</style>
            <style>
              html, body { width: 100%; height: 100%; margin: 0; }
              body { display: grid; place-items: center; background: #eee; }
            </style>
          </head>
          <body>${markup}</body>
        </html>`);
      const layout = await page.evaluate((fixture) => {
        const dialog = document.querySelector(`[data-step="${fixture.step}"]`);
        const content = dialog?.querySelector(`[aria-label="${fixture.ariaLabel}"]`);
        const shell = content?.parentElement;
        const button = Array.from(dialog?.querySelectorAll("button") ?? []).find(
          (candidate) => candidate.textContent?.trim() === fixture.buttonText,
        );
        if (
          !(dialog instanceof HTMLElement) ||
          !(shell instanceof HTMLElement) ||
          !(content instanceof HTMLElement) ||
          !(button instanceof HTMLElement)
        )
          return null;
        const dialogRect = dialog.getBoundingClientRect();
        const shellRect = shell.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const dialogStyle = getComputedStyle(dialog);
        const shellStyle = getComputedStyle(shell);
        const hitTarget = document.elementFromPoint(
          buttonRect.left + buttonRect.width / 2,
          buttonRect.top + buttonRect.height / 2,
        );
        return {
          buttonBottom: buttonRect.bottom,
          buttonHeight: buttonRect.height,
          buttonTop: buttonRect.top,
          dialogBottom: dialogRect.bottom,
          dialogHeight: dialogRect.height,
          dialogGridRows: dialogStyle.gridTemplateRows,
          dialogPaddingBottom: dialogStyle.paddingBottom,
          dialogTop: dialogRect.top,
          hitTargetIsButton: hitTarget === button || button.contains(hitTarget),
          contentBottom: contentRect.bottom,
          contentTop: contentRect.top,
          shellBottom: shellRect.bottom,
          shellHeight: shellRect.height,
          shellOverflow: shellStyle.overflow,
          shellTop: shellRect.top,
        };
      }, fixture);
      const evidence = JSON.stringify({ viewport, layout });
      assert.ok(layout, `${fixture.fixtureName} layout fixture must render its action: ${evidence}`);
      assert.ok(layout.buttonHeight >= 36, `${fixture.fixtureName} action must keep its full height: ${evidence}`);
      assert.ok(
        layout.buttonTop >= layout.shellTop && layout.buttonBottom <= layout.shellBottom,
        `${fixture.fixtureName} action must remain fully visible inside the content shell: ${evidence}`,
      );
      assert.ok(
        layout.contentTop >= layout.shellTop && layout.contentBottom <= layout.shellBottom,
        `${fixture.fixtureName} content must remain contained by the content shell: ${evidence}`,
      );
      assert.ok(
        layout.buttonTop >= layout.dialogTop && layout.buttonBottom <= layout.dialogBottom,
        `${fixture.fixtureName} action must remain fully visible inside the dialog: ${evidence}`,
      );
      assert.equal(
        layout.hitTargetIsButton,
        true,
        `${fixture.fixtureName} action center must remain clickable: ${evidence}`,
      );
    }
  } finally {
    await browser.close();
  }
}

function withdrawalInteractionEntrySource() {
  return `
    import React, { useEffect, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { WithdrawalDialogContent } from ${JSON.stringify(resolve(projectRoot, "web/src/components/sidebar/app-navigation.tsx"))};
    import {
      STRIPE_ONBOARDING_PAGE_ID,
      STRIPE_ONBOARDING_PENDING_KEY,
    } from ${JSON.stringify(resolve(projectRoot, "web/src/stripe-onboarding-lifecycle.ts"))};

    globalThis.__OPENGROVE_API_BASE__ = "/api/";
    const scenario = new URLSearchParams(location.search).get("scenario") || "raw-error";
    const readyStatus = {
      settlement: { countryCode: "GB", provider: "stripe", currency: "USD" },
      stripeConnect: {
        consentAccepted: true,
        readyForPayout: true,
        missingRequirements: [],
      },
      balanceCents: 10_000,
      withdrawalCount: 0,
      totalEarningsCents: 10_000,
      frozenCents: 0,
      totalWithdrawnCents: 0,
      identityInfoStatus: "verified",
      bankCardStatus: "verified",
      contractStatus: "signed",
      signingUrl: "",
      bankCardLast4: "4242",
      profileFieldErrors: {},
      payoutInProgress: false,
      activePayout: null,
      withdrawalRecords: [],
      recordsStatus: "ready",
    };

    if (scenario === "desktop-return" || scenario === "web-return") {
      sessionStorage.setItem(
        STRIPE_ONBOARDING_PENDING_KEY,
        scenario === "desktop-return" ? STRIPE_ONBOARDING_PAGE_ID : "previous-document",
      );
    }

    function Harness() {
      const [status, setStatus] = useState(readyStatus);
      const [runtime, setRuntime] = useState({ error: "", pendingAction: null, signingUrl: "" });
      const [step, setStep] = useState(
        scenario === "confirm-revalidate" || scenario === "confirm-ready"
          ? "confirm"
          : scenario === "desktop-return" || scenario === "web-return"
            ? "stripe_setup"
            : "overview",
      );
      useEffect(() => {
        window.__withdrawalFixtureState = { runtime, status, step };
      }, [runtime, status, step]);
      return <WithdrawalDialogContent
        onAuthExpired={() => {}}
        onRuntimePatch={(patch) => setRuntime((current) => ({ ...current, ...patch }))}
        onRecordsLoadMore={() => {}}
        onRecordsOpen={() => {}}
        onContractStateChange={() => {}}
        onStatusChange={setStatus}
        onStepChange={setStep}
        onToast={() => {}}
        onWithdrawalSuccessComplete={() => {}}
        latestPayoutNotice={null}
        recordsPage={{ error: "", loading: false, loadingMore: false, syncing: false, page: 0, pageSize: 20, records: [], total: 0 }}
        runtime={runtime}
        status={status}
        step={step}
      />;
    }

    createRoot(document.getElementById("root")).render(<Harness />);
  `;
}

async function assertStripeWithdrawalInteractions(bundle) {
  const browser = await launchBrowser();
  try {
    const rawError = await openWithdrawalInteractionScenario(browser, bundle, "raw-error");
    await rawError.page.getByRole("button", { name: "Withdraw all" }).click();
    await rawError.page.waitForFunction(() => document.body.textContent?.includes("Request failed. Try again later."));
    const rawErrorBody = await rawError.page.locator("body").innerText();
    assert.match(rawErrorBody, /Request failed\. Try again later\./);
    assert.doesNotMatch(rawErrorBody, /Stripe exploded|withdrawal_[a-z_]+/);
    await rawError.page.close();

    const unsignedAgreement = await openWithdrawalInteractionScenario(browser, bundle, "unsigned-agreement");
    await unsignedAgreement.page.getByRole("button", { name: "Withdraw all" }).click();
    await unsignedAgreement.page.waitForFunction(() =>
      document.body.textContent?.includes("Complete signing in Story Seed first"),
    );
    await unsignedAgreement.page.getByRole("button", { name: "Check signing status" }).click();
    await unsignedAgreement.page.waitForTimeout(50);
    assert.equal(
      unsignedAgreement.requests.some(
        (request) => request.method === "POST" && request.pathname === "/api/v1/stripe-connect/consents",
      ),
      false,
      "checking Story Seed signing must not call the legacy Stripe consent endpoint",
    );
    assert.equal(
      unsignedAgreement.requests.filter((request) => request.pathname === "/api/v1/stripe-connect/status").length,
      2,
      "the initial check and the user's signing-status refresh must both read the server status",
    );
    await unsignedAgreement.page.close();

    const revalidation = await openWithdrawalInteractionScenario(browser, bundle, "confirm-revalidate");
    await revalidation.page.getByRole("button", { name: "Confirm withdrawal" }).click();
    await revalidation.page.waitForFunction(() => document.body.textContent?.includes("Continue to Stripe"));
    assert.equal(
      revalidation.requests.some(
        (request) => request.method === "POST" && request.pathname === "/api/v1/payout-orders",
      ),
      false,
      "Stripe confirmation must not create an order after the refreshed Connect status becomes unready",
    );
    assert.match(await revalidation.page.locator("body").innerText(), /Continue to Stripe/);
    assert.equal(revalidation.requests[0]?.pathname, "/api/v1/users/me");
    assert.equal(
      revalidation.requests.some((request) => request.pathname === "/api/v1/stripe-connect/status"),
      true,
    );
    await revalidation.page.close();

    const readyConfirmation = await openWithdrawalInteractionScenario(browser, bundle, "confirm-ready");
    await readyConfirmation.page.getByRole("button", { name: "Confirm withdrawal" }).click();
    await readyConfirmation.page.waitForFunction(() => document.body.textContent?.includes("Processing at bank"));
    const readyCreateIndex = readyConfirmation.requests.findIndex(
      (request) => request.method === "POST" && request.pathname === "/api/v1/payout-orders",
    );
    assert.ok(readyCreateIndex > 0, "a ready Stripe payout must be created after status revalidation");
    assert.equal(readyConfirmation.requests[0]?.pathname, "/api/v1/users/me");
    assert.ok(
      readyConfirmation.requests.findIndex((request) => request.pathname === "/api/v1/stripe-connect/status") <
        readyCreateIndex,
      "Connect status must be refreshed before order creation",
    );
    assert.equal(
      (await readyConfirmation.page.evaluate(() => window.__withdrawalFixtureState.status)).balanceCents,
      0,
      "the post-order balance must come from the refreshed server status",
    );
    assert.equal(
      (await readyConfirmation.page.evaluate(() => window.__withdrawalFixtureState.status)).frozenCents,
      10_000,
      "the post-order frozen amount must come from the refreshed server status",
    );
    await readyConfirmation.page.close();

    const desktopReturn = await openWithdrawalInteractionScenario(browser, bundle, "desktop-return");
    await desktopReturn.page.waitForTimeout(100);
    assert.equal(
      desktopReturn.requests.some((request) => request.pathname === "/api/v1/stripe-connect/sync"),
      false,
      "opening the system browser must not synchronize before the user returns",
    );
    const syncResponse = desktopReturn.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/stripe-connect/sync",
    );
    await desktopReturn.page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await syncResponse;
    await desktopReturn.page.waitForTimeout(50);
    assert.equal(
      desktopReturn.requests.filter((request) => request.pathname === "/api/v1/stripe-connect/sync").length,
      1,
      "returning focus to the desktop app must synchronize Stripe Connect exactly once",
    );
    await desktopReturn.page.close();

    const webReturn = await openWithdrawalInteractionScenario(browser, bundle, "web-return");
    await webReturn.page.waitForTimeout(100);
    assert.equal(
      webReturn.requests.filter((request) => request.pathname === "/api/v1/stripe-connect/sync").length,
      1,
      "a new browser document returning from Stripe must synchronize immediately",
    );
    await webReturn.page.close();
  } finally {
    await browser.close();
  }
}

async function openWithdrawalInteractionScenario(browser, bundle, scenario) {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const requests = [];
  let payoutCreated = false;
  await page.route("http://withdrawal.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/") {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
      return;
    }
    if (url.pathname === "/fixture.js") {
      await route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle });
      return;
    }
    requests.push({ method: request.method(), pathname: url.pathname });
    if (scenario === "raw-error" && url.pathname === "/api/v1/users/me") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: 100003, message: "Stripe exploded", request_id: "req-raw-error" } }),
      });
      return;
    }
    if (url.pathname === "/api/v1/users/me") {
      await route.fulfill({
        json: {
          data: {
            country_code: "GB",
            payout_provider: "stripe",
            cash_currency: "USD",
            cash_balance_cents: payoutCreated ? 0 : 10_000,
            cash_frozen_cents: payoutCreated ? 10_000 : 0,
            total_cash_earned_cents: 10_000,
            total_cash_withdrawn_cents: 0,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/stripe-connect/status" || url.pathname === "/api/v1/stripe-connect/sync") {
      const readyForPayout = scenario === "confirm-ready";
      const consentAccepted = scenario !== "unsigned-agreement";
      await route.fulfill({
        json: {
          data: {
            agreement_version: "2026-08-19",
            consent_accepted: consentAccepted,
            ready_for_payout: readyForPayout,
            missing_requirements: readyForPayout
              ? []
              : consentAccepted
                ? ["connected_account"]
                : ["consent", "connected_account"],
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/payout-orders" && request.method() === "GET") {
      await route.fulfill({ json: emptyOrdersResponse });
      return;
    }
    if (url.pathname === "/api/v1/payout-orders" && request.method() === "POST") {
      payoutCreated = true;
      await route.fulfill({ json: { data: { order_id: "unexpected-order", status: "created" } } });
      return;
    }
    if (url.pathname === "/api/v1/payout-orders/unexpected-order") {
      await route.fulfill({
        json: {
          data: {
            order_id: "unexpected-order",
            provider: "stripe",
            currency: "USD",
            channel: "bank_account",
            amount_cents: 10_000,
            status: "processing",
            provider_status: "payout_pending",
            created_at: "2026-08-24T08:00:00Z",
            updated_at: "2026-08-24T08:00:00Z",
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected_fixture_route" } });
  });
  await page.goto(`http://withdrawal.test/?scenario=${encodeURIComponent(scenario)}`);
  await page.waitForSelector("button");
  return { page, requests };
}

function cssStubPlugin() {
  return {
    name: "css-stub",
    setup(buildApi) {
      buildApi.onResolve({ filter: /\.css$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path),
        namespace: "css-empty-stub",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "css-empty-stub" }, () => ({
        contents: "export default {};",
        loader: "js",
      }));
    },
  };
}

async function assertLoopbackOriginIsolation(testRoot) {
  const environmentKeys = [
    "OPENGROVE_BRIDGE_SETTINGS_PATH",
    "OPENGROVE_DATA_DIR",
    "OPENGROVE_USER_DATA_DIR",
    "OPENGROVE_WEB_AUTH_MODE",
    "OPENGROVE_WW_BASE_URL",
  ];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  let browser;
  let bridge;
  let attacker;
  let payoutRequests = 0;
  const ww = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/v1/users/me") {
      sendJson(response, 200, {
        data: {
          user_id: "origin-test-user",
          email: "origin-test@example.test",
          role: "member",
          cash_balance_cents: 1_000,
          cash_frozen_cents: 0,
          total_cash_earned_cents: 1_000,
          total_cash_withdrawn_cents: 0,
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/payout-orders") {
      payoutRequests += 1;
      sendJson(response, 200, { ok: true, order_id: `origin-order-${payoutRequests}`, status: "processing" });
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  });

  try {
    const wwOrigin = await listenOnLoopback(ww);
    process.env.OPENGROVE_BRIDGE_SETTINGS_PATH = join(testRoot, "origin-bridge-settings.json");
    process.env.OPENGROVE_DATA_DIR = testRoot;
    process.env.OPENGROVE_USER_DATA_DIR = testRoot;
    process.env.OPENGROVE_WEB_AUTH_MODE = "session";
    process.env.OPENGROVE_WW_BASE_URL = wwOrigin;
    cacheAuthSessionUser(
      "origin-session",
      "origin-access",
      {
        userId: "origin-test-user",
        email: "origin-test@example.test",
        displayName: "Origin Test",
        role: "member",
      },
      3_600,
    );

    bridge = startOpenGroveServer({
      host: "127.0.0.1",
      port: 0,
      profile: "test",
      runtimeEnvironment: "test",
      statePath: join(testRoot, "origin-state.json"),
    });
    if (!bridge.listening) await new Promise((resolveListen) => bridge.once("listening", resolveListen));
    const bridgeAddress = bridge.address();
    assert.ok(bridgeAddress && typeof bridgeAddress === "object");
    const bridgeOrigin = `http://127.0.0.1:${bridgeAddress.port}`;

    attacker = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<script>
fetch(${JSON.stringify(`${bridgeOrigin}/api/v1/payout-orders`)}, { method: "POST", credentials: "include" })
  .then(async (result) => { document.body.textContent = result.status + ":" + await result.text(); })
  .catch((error) => { document.body.textContent = "error:" + error.message; });
</script>`);
    });
    const attackerOrigin = await listenOnLoopback(attacker);

    browser = await launchBrowser();
    const context = await browser.newContext();
    await context.addCookies([
      { name: "opengrove_auth_access", value: "origin-access", url: bridgeOrigin, httpOnly: true, sameSite: "Lax" },
      { name: "opengrove_auth_refresh", value: "origin-refresh", url: bridgeOrigin, httpOnly: true, sameSite: "Lax" },
      { name: "opengrove_auth_session", value: "origin-session", url: bridgeOrigin, sameSite: "Lax" },
    ]);
    const page = await context.newPage();
    await page.goto(attackerOrigin);
    await page.waitForFunction(() => document.body.textContent?.startsWith("403:"));
    assert.match(await page.locator("body").innerText(), /withdrawal_origin_not_allowed/u);
    assert.equal(payoutRequests, 0, "a foreign loopback origin must not create a payout");

    await page.goto(`${bridgeOrigin}/opengrove-probe`);
    const sameOriginResult = await page.evaluate(async () => {
      const response = await fetch("/api/v1/payout-orders", { method: "POST", credentials: "include" });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(sameOriginResult.status, 200);
    assert.equal(sameOriginResult.body.order_id, "origin-order-1");
    assert.equal(payoutRequests, 1, "the exact Host origin must remain able to create a payout");
  } finally {
    await browser?.close();
    await closeServer(attacker);
    await closeServer(bridge);
    await closeServer(ww);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!/executable.*doesn't exist|browser.*not found/iu.test(String(error))) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

async function listenOnLoopback(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
