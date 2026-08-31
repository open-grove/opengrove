import { APP_STORAGE_KEYS } from "./identity";

type AccountOnboardingReader = Pick<Storage, "getItem">;
type AccountOnboardingWriter = Pick<Storage, "setItem">;

const ACCOUNT_ONBOARDING_COMPLETED = "completed";

export function readAccountOnboardingCompleted(
  storage: AccountOnboardingReader | undefined = browserStorage(),
): boolean {
  return storage?.getItem(APP_STORAGE_KEYS.accountOnboarding) === ACCOUNT_ONBOARDING_COMPLETED;
}

export function markAccountOnboardingCompleted(storage: AccountOnboardingWriter | undefined = browserStorage()): void {
  storage?.setItem(APP_STORAGE_KEYS.accountOnboarding, ACCOUNT_ONBOARDING_COMPLETED);
}

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
