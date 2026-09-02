import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { createCookieAuthSession, createOpenGroveClient } from "#client";
import { deleteCliAuthState, hasCliAuthCookies, readCliAuthState, writeCliAuthState } from "./auth-state.js";
import { DEFAULT_CLI_BRIDGE_API_URL, resolveCliBridge, type CliBridgeBaseUrlSource } from "./bridge-connection.js";
import { OpenGroveCliError } from "./errors.js";
import {
  HOST_OPERATION_CLI_EXIT,
  hostOperationCliFailure,
  hostOperationCliSuccess,
  type HostOperationCliResult,
} from "./host-operation-output.js";

const AUTH_REFRESH_COOKIE = "opengrove_auth_refresh";

const USAGE = `OpenGrove account authentication

Usage:
  opengrove auth login [--email EMAIL] [--country-code CODE] [--invite-code CODE] [--base-url URL]
  opengrove auth status [--base-url URL]
  opengrove auth logout [--base-url URL]

Commands:
  login    Sign in with the existing OpenGrove email-code flow.
  status   Verify and display the saved CLI account session.
  logout   Revoke the CLI session when possible and always clear it locally.
`;

export type AuthCliOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  authPath?: string;
  discoveryPaths?: readonly string[];
  prompt?: (question: string) => Promise<string>;
}>;

export function isAuthWorkflowCommand(args: readonly string[]): boolean {
  if (args[0] !== "auth") return false;
  const command = args[1];
  return (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    command === "login" ||
    command === "status" ||
    command === "logout"
  );
}

export async function runAuthCommand(
  args: readonly string[],
  options: AuthCliOptions = {},
): Promise<HostOperationCliResult> {
  const command = args[0];
  if (!command || command === "help" || args.includes("--help") || args.includes("-h")) {
    return { handled: true, exitCode: HOST_OPERATION_CLI_EXIT.success, stdout: USAGE.trimEnd() };
  }
  try {
    if (command === "login") return await login(args.slice(1), options);
    if (command === "status") return await status(args.slice(1), options);
    if (command === "logout") return await logout(args.slice(1), options);
    throw new OpenGroveCliError("validation", "command_not_found", `Unknown auth command: ${command}`);
  } catch (error) {
    return hostOperationCliFailure(`auth.${command}`, error);
  }
}

async function login(args: readonly string[], options: AuthCliOptions): Promise<HostOperationCliResult> {
  const parsed = parseAuthOptions(args, ["email", "country-code", "invite-code", "base-url"], options.env);
  const prompt = options.prompt ?? promptLine;
  const email = (parsed.values.email ?? (await prompt("Account email: "))).trim();
  if (!email) throw new OpenGroveCliError("validation", "invalid_email", "An account email is required.");

  const saved = readCliAuthState(options.authPath);
  const connection = await resolveCliBridge({
    baseUrl: parsed.baseUrl,
    baseUrlSource: parsed.baseUrlSource,
    ...(saved?.bridgeApiUrl ? { savedApiUrl: saved.bridgeApiUrl } : {}),
    fetch: options.fetch,
    discoveryPaths: options.discoveryPaths,
  });
  const stagedAuth = createCookieAuthSession();
  const client = createOpenGroveClient({ baseUrl: connection.apiUrl, fetch: options.fetch, auth: stagedAuth });
  const codeRequest = await client.auth.emailCodes.create({ email });
  const countryCode = codeRequest.requiresCountry
    ? (parsed.values["country-code"] ?? (await prompt("Country or region code: "))).trim()
    : parsed.values["country-code"]?.trim();
  const inviteCode = codeRequest.requiresInvite
    ? (parsed.values["invite-code"] ?? (await prompt("Invite code: "))).trim()
    : parsed.values["invite-code"]?.trim();
  if (codeRequest.requiresCountry && !countryCode) {
    throw new OpenGroveCliError("validation", "country_code_required", "A country or region code is required.");
  }
  if (codeRequest.requiresInvite && !inviteCode) {
    throw new OpenGroveCliError("validation", "invite_code_required", "An invite code is required.");
  }

  const code = (await prompt("Verification code from your email (6 digits): ")).trim();
  if (!/^\d{6}$/u.test(code)) {
    throw new OpenGroveCliError("validation", "verification_code_invalid", "The verification code must be 6 digits.");
  }
  await client.auth.session.create({
    email,
    code,
    ...(countryCode ? { countryCode } : {}),
    ...(inviteCode ? { inviteCode } : {}),
    deviceName: `opengrove-cli@${hostname()}`,
    platform: process.platform,
  });
  if (!stagedAuth.snapshot()[AUTH_REFRESH_COOKIE]) {
    throw new OpenGroveCliError(
      "authentication",
      "login_no_session_credentials",
      "The Bridge accepted the login but returned no renewable CLI session.",
    );
  }
  const session = await client.auth.session.get();
  if (session.status !== "authenticated" || session.authenticated !== true) {
    throw new OpenGroveCliError(
      "authentication",
      "login_session_unverified",
      "The Bridge did not confirm an authenticated CLI session.",
    );
  }
  const cookies = stagedAuth.snapshot();
  if (!cookies[AUTH_REFRESH_COOKIE]) {
    throw new OpenGroveCliError(
      "authentication",
      "login_no_session_credentials",
      "The verified session has no renewable CLI credential.",
    );
  }
  writeCliAuthState(
    { bridgeApiUrl: connection.apiUrl, stateId: connection.stateId, email, cookies: { ...cookies } },
    options.authPath,
  );
  return hostOperationCliSuccess({ ok: true, identity: "user", data: session });
}

async function status(args: readonly string[], options: AuthCliOptions): Promise<HostOperationCliResult> {
  const parsed = parseAuthOptions(args, ["base-url"], options.env);
  const saved = readCliAuthState(options.authPath);
  if (!hasCliAuthCookies(saved)) {
    return hostOperationCliSuccess({
      ok: true,
      identity: "none",
      data: { status: "unauthenticated", authenticated: false, reason: "missing_cli_session" },
    });
  }
  const connection = await resolveCliBridge({
    baseUrl: parsed.baseUrl,
    baseUrlSource: parsed.baseUrlSource,
    savedApiUrl: saved.bridgeApiUrl,
    expectedStateId: saved.stateId,
    fetch: options.fetch,
    discoveryPaths: options.discoveryPaths,
  });
  const auth = createCookieAuthSession({
    cookies: saved.cookies,
    onChange: (cookies) => {
      writeCliAuthState(
        {
          bridgeApiUrl: connection.apiUrl,
          stateId: connection.stateId,
          ...(saved.email ? { email: saved.email } : {}),
          cookies: { ...cookies },
        },
        options.authPath,
      );
    },
  });
  const client = createOpenGroveClient({ baseUrl: connection.apiUrl, fetch: options.fetch, auth });
  const session = await client.auth.session.get();
  if (session.status === "unauthenticated") deleteCliAuthState(options.authPath);
  return hostOperationCliSuccess({
    ok: true,
    identity: session.status === "authenticated" ? "user" : "none",
    data: session,
  });
}

async function logout(args: readonly string[], options: AuthCliOptions): Promise<HostOperationCliResult> {
  const parsed = parseAuthOptions(args, ["base-url"], options.env);
  const saved = readCliAuthState(options.authPath);
  if (!hasCliAuthCookies(saved)) {
    deleteCliAuthState(options.authPath);
    return hostOperationCliSuccess({
      ok: true,
      identity: "none",
      data: { loggedOut: true, remoteRevocation: "not_attempted" },
    });
  }

  let remoteRevocation: "succeeded" | "failed" = "failed";
  try {
    const connection = await resolveCliBridge({
      baseUrl: parsed.baseUrl,
      baseUrlSource: parsed.baseUrlSource,
      savedApiUrl: saved.bridgeApiUrl,
      expectedStateId: saved.stateId,
      fetch: options.fetch,
      discoveryPaths: options.discoveryPaths,
    });
    const auth = createCookieAuthSession({ cookies: saved.cookies });
    const client = createOpenGroveClient({ baseUrl: connection.apiUrl, fetch: options.fetch, auth });
    await client.auth.session.delete();
    remoteRevocation = "succeeded";
  } catch {
    // non-critical-fallback: local logout must still remove credentials when the Bridge cannot revoke them.
  } finally {
    deleteCliAuthState(options.authPath);
  }
  return hostOperationCliSuccess({
    ok: true,
    identity: "none",
    data: { loggedOut: true, remoteRevocation },
  });
}

function parseAuthOptions(
  args: readonly string[],
  allowed: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): { values: Record<string, string>; baseUrl: string; baseUrlSource: CliBridgeBaseUrlSource } {
  const values: Record<string, string> = {};
  let baseUrl = env.OPENGROVE_BRIDGE_URL?.trim() || DEFAULT_CLI_BRIDGE_API_URL;
  let baseUrlSource: CliBridgeBaseUrlSource = env.OPENGROVE_BRIDGE_URL?.trim() ? "environment" : "default";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      throw new OpenGroveCliError("validation", "unexpected_argument", `Unexpected argument: ${arg}`);
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    if (!allowed.includes(name)) {
      throw new OpenGroveCliError("validation", "unknown_option", `Unknown auth option: --${name}`);
    }
    if (Object.hasOwn(values, name)) {
      throw new OpenGroveCliError("validation", "duplicate_option", `--${name} may only be provided once.`);
    }
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
    if (!value || (equals === -1 && value.startsWith("--"))) {
      throw new OpenGroveCliError("validation", "option_value_required", `--${name} requires a value.`);
    }
    values[name] = value;
    if (equals === -1) index += 1;
    if (name === "base-url") {
      baseUrl = value;
      baseUrlSource = "flag";
    }
  }
  return { values, baseUrl, baseUrlSource };
}

async function promptLine(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}
