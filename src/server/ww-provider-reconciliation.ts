import { createHash } from "node:crypto";
import { z } from "zod";
import type { WwApiError } from "./ww/types.js";

export const wwProviderReconciliationSchema = z.object({
  status: z.enum(["pending", "ready", "retrying", "needs-login", "blocked"]),
  reason: z.string().optional(),
  attempt: z.number().int().nonnegative(),
  retryAt: z.iso.datetime().optional(),
  lastVerifiedAt: z.iso.datetime().optional(),
});
export type WwProviderReconciliation = z.infer<typeof wwProviderReconciliationSchema>;

export const wwVerifiedCredentialSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
});
export type WwVerifiedCredential = z.infer<typeof wwVerifiedCredentialSchema>;

export function wwCredentialFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function failedWwReconciliation(
  error: unknown,
  previous?: WwProviderReconciliation,
  now = Date.now(),
): WwProviderReconciliation {
  const apiError = error instanceof Error ? (error as Partial<WwApiError>) : undefined;
  const status = apiError?.status;
  const replayExpired = apiError?.message === "ww_api_key_provisioning_replay_expired";
  const invalidResponse =
    error instanceof SyntaxError || Boolean(error && typeof error === "object" && "validationCode" in error);
  const retryable =
    !replayExpired &&
    !invalidResponse &&
    (status === undefined || status === 408 || status === 425 || status === 429 || status >= 500);
  const attempt = (previous?.attempt ?? 0) + 1;
  const delays = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  const backoff = delays[Math.min(attempt - 1, delays.length - 1)] ?? 300_000;
  const waitMs = Math.max(backoff * (0.8 + Math.random() * 0.2), (apiError?.retryAfter ?? 0) * 1000);
  return {
    status: retryable ? "retrying" : status === 401 ? "needs-login" : "blocked",
    reason: retryable
      ? "network_unavailable"
      : status === 401
        ? "session_expired"
        : replayExpired
          ? "recovery_expired"
          : "verification_rejected",
    attempt,
    ...(retryable ? { retryAt: new Date(now + waitMs).toISOString() } : {}),
    ...(previous?.lastVerifiedAt ? { lastVerifiedAt: previous.lastVerifiedAt } : {}),
  };
}
