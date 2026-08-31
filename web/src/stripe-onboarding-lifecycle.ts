export const STRIPE_ONBOARDING_PENDING_KEY = "opengrove:stripe-onboarding-pending";

export const STRIPE_ONBOARDING_PAGE_ID = createPageInstanceId();

export function shouldSyncStripeOnboardingOnMount(pendingPageId: string): boolean {
  return Boolean(pendingPageId) && pendingPageId !== STRIPE_ONBOARDING_PAGE_ID;
}

function createPageInstanceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
