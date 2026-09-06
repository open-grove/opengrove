/**
 * The test-account switcher.
 *
 * The account list is not defined here: it comes from ww at runtime, which keeps
 * those addresses out of the shipped web bundle and keeps the two ends from
 * drifting. Switching is one request that returns a full session -- there is no
 * verification code, because proving team membership already happened when the
 * team token was accepted, and no intermediate logged-out state to get stuck in.
 */
export interface DevFixtureAccount {
  email: string;
  roles: string[];
  status: string;
}

export interface DevFixtureAuthPort<Result> {
  signIn(email: string): Promise<Result>;
}

export function devFixtureAccountSwitcherAvailable(input: {
  isOfficialRelease: boolean | undefined;
  sessionAuthActive: boolean;
  teamGateSatisfied: boolean;
}): boolean {
  return (
    // Compile-time: the switcher is absent from any bundle not built with
    // OPENGROVE_WEB_DEV_FIXTURE_ACCOUNTS=1, and check-web-fixture-account-boundary
    // verifies that by scanning the built bytes.
    __OPENGROVE_DEV_FIXTURE_ACCOUNTS__ &&
    // A packaged official release always hides it. Compared against true rather
    // than false because undefined means "not running in the desktop shell" --
    // a browser has no notion of a release build, and gating on it there would
    // hide the switcher for a reason that does not apply.
    input.isOfficialRelease !== true &&
    input.sessionAuthActive &&
    // Without the team token ww refuses both to list these accounts and to
    // grant them, so offering the switcher would only produce failures.
    input.teamGateSatisfied
  );
}

export async function switchDevFixtureAccount<Result>(
  account: Pick<DevFixtureAccount, "email">,
  auth: DevFixtureAuthPort<Result>,
): Promise<Result> {
  return auth.signIn(account.email);
}
