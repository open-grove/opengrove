import type { LanguagePreference, ResolvedLanguage } from "./i18n-types";

export interface DevFixtureAccount {
  id: string;
  email: string;
  countryCode: string;
  roles: readonly string[];
  enabled: boolean;
}

export interface DevFixtureLoginPayload {
  email: string;
  code: string;
  countryCode: string;
  deviceName: string;
  platform: string;
  languagePreference: LanguagePreference;
  systemLanguage: ResolvedLanguage;
}

export interface DevFixtureAuthPort<Result> {
  logout(): Promise<unknown>;
  sendEmailCode(payload: { email: string }): Promise<unknown>;
  login(payload: DevFixtureLoginPayload): Promise<Result>;
}

export function devFixtureAccountSwitcherAvailable(input: {
  isOfficialRelease: boolean | undefined;
  sessionAuthActive: boolean;
}): boolean {
  return __OPENGROVE_DEV_FIXTURE_ACCOUNTS__ && input.isOfficialRelease === false && input.sessionAuthActive;
}

export async function switchDevFixtureAccount<Result>(
  account: DevFixtureAccount,
  language: Pick<DevFixtureLoginPayload, "languagePreference" | "systemLanguage">,
  auth: DevFixtureAuthPort<Result>,
): Promise<Result> {
  if (!account.enabled) throw new Error("fixture_account_disabled");
  await auth.logout();
  await auth.sendEmailCode({ email: account.email });
  return auth.login({
    email: account.email,
    code: "000000",
    countryCode: account.countryCode,
    deviceName: "OpenGrove fixture switcher",
    platform: "macos",
    ...language,
  });
}

export const DEV_FIXTURE_ACCOUNTS: readonly DevFixtureAccount[] = __OPENGROVE_DEV_FIXTURE_ACCOUNTS__
  ? [
      { id: "1001", email: "cn-writer-a@example.test", countryCode: "CN", roles: ["storyseed_writer"], enabled: true },
      { id: "1002", email: "cn-writer-b@example.test", countryCode: "CN", roles: ["storyseed_writer"], enabled: true },
      { id: "1003", email: "cn-writer-c@example.test", countryCode: "CN", roles: ["storyseed_writer"], enabled: true },
      { id: "1004", email: "cn-editor-a@example.test", countryCode: "CN", roles: ["storyseed_editor"], enabled: true },
      { id: "1005", email: "cn-editor-b@example.test", countryCode: "CN", roles: ["storyseed_editor"], enabled: true },
      { id: "1006", email: "cn-admin-a@example.test", countryCode: "CN", roles: ["admin"], enabled: true },
      {
        id: "1007",
        email: "cn-admin-b@example.test",
        countryCode: "CN",
        roles: ["admin", "storyseed_editor"],
        enabled: true,
      },
      { id: "1008", email: "cn-supplier-a@example.test", countryCode: "CN", roles: ["vega_supplier"], enabled: true },
      { id: "1009", email: "cn-supplier-b@example.test", countryCode: "CN", roles: ["vega_supplier"], enabled: true },
      { id: "1010", email: "cn-reviewer-a@example.test", countryCode: "CN", roles: ["vega_reviewer"], enabled: true },
      { id: "1011", email: "cn-noaccount@example.test", countryCode: "CN", roles: ["storyseed_writer"], enabled: true },
      { id: "1012", email: "cn-disabled@example.test", countryCode: "CN", roles: ["storyseed_writer"], enabled: false },
      { id: "1013", email: "cn-noroles@example.test", countryCode: "CN", roles: [], enabled: true },
      { id: "1014", email: "cn-mismatch@example.test", countryCode: "CN", roles: ["user"], enabled: true },
      { id: "1015", email: "cn-cash-odd@example.test", countryCode: "CN", roles: ["storyseed_writer"], enabled: true },
      {
        id: "1016",
        email: "cn-cash-frozen@example.test",
        countryCode: "CN",
        roles: ["storyseed_writer"],
        enabled: true,
      },
      { id: "1017", email: "us-writer-a@example.test", countryCode: "US", roles: ["storyseed_writer"], enabled: true },
      { id: "1018", email: "us-writer-b@example.test", countryCode: "US", roles: ["storyseed_writer"], enabled: true },
      { id: "1019", email: "ng-writer-a@example.test", countryCode: "NG", roles: ["storyseed_writer"], enabled: true },
      { id: "1020", email: "ng-writer-b@example.test", countryCode: "NG", roles: ["storyseed_writer"], enabled: true },
      { id: "1021", email: "us-editor-a@example.test", countryCode: "US", roles: ["storyseed_editor"], enabled: true },
      { id: "1022", email: "us-admin-a@example.test", countryCode: "US", roles: ["admin"], enabled: true },
      { id: "1023", email: "gb-singleton@example.test", countryCode: "GB", roles: ["user"], enabled: true },
      { id: "1024", email: "us-reviewer-a@example.test", countryCode: "US", roles: ["vega_reviewer"], enabled: true },
    ]
  : [];
