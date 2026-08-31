import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export function resolveAppleNotaryCredentials(env = process.env, fileExists = existsSync) {
  const groups = [
    {
      strategy: "api-key",
      values: [env.APPLE_API_KEY, env.APPLE_API_KEY_ID, env.APPLE_API_ISSUER],
      required: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    },
    {
      strategy: "apple-id",
      values: [env.APPLE_ID, env.APPLE_APP_SPECIFIC_PASSWORD, env.APPLE_TEAM_ID],
      required: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    },
    {
      strategy: "keychain-profile",
      values: [env.APPLE_KEYCHAIN_PROFILE, env.APPLE_KEYCHAIN],
      required: ["APPLE_KEYCHAIN_PROFILE"],
    },
  ];
  const configured = groups.filter((group) => group.values.some(nonEmpty));
  if (configured.length === 0) {
    throw new Error(
      "Apple notarization credentials are missing; configure exactly one of " +
        "APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, " +
        "APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_KEYCHAIN_PROFILE",
    );
  }
  if (configured.length !== 1) {
    throw new Error(
      `multiple Apple notarization credential strategies are configured: ${configured.map((item) => item.strategy).join(", ")}`,
    );
  }

  const selected = configured[0];
  const missing = selected.required.filter((name) => !nonEmpty(env[name]));
  if (missing.length > 0) {
    throw new Error(`${selected.strategy} notarization credentials are incomplete; missing ${missing.join(", ")}`);
  }

  let args;
  let redactedArgs;
  let fingerprintValues;
  if (selected.strategy === "api-key") {
    if (!fileExists(env.APPLE_API_KEY)) {
      throw new Error(`APPLE_API_KEY file does not exist: ${env.APPLE_API_KEY}`);
    }
    args = ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
    redactedArgs = ["--key", "[KEY_FILE]", "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
    fingerprintValues = args;
  } else if (selected.strategy === "apple-id") {
    args = ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
    redactedArgs = ["--apple-id", "[APPLE_ID]", "--password", "[REDACTED]", "--team-id", env.APPLE_TEAM_ID];
    fingerprintValues = ["--apple-id", env.APPLE_ID, "--team-id", env.APPLE_TEAM_ID];
  } else {
    args = ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE];
    if (nonEmpty(env.APPLE_KEYCHAIN)) args.push("--keychain", env.APPLE_KEYCHAIN);
    redactedArgs = [...args];
    fingerprintValues = args;
  }

  return {
    strategy: selected.strategy,
    args,
    redactedArgs,
    fingerprint: createHash("sha256").update(JSON.stringify(fingerprintValues)).digest("hex"),
  };
}

export function windowsSigningProblems(env = process.env, fileExists = existsSync) {
  const problems = [];
  const cscLink = env.CSC_LINK;
  const cscPassword = env.CSC_KEY_PASSWORD;
  const expectedSubject = env.OPENGROVE_WINDOWS_SIGNING_SUBJECT;
  const expectedThumbprint = env.OPENGROVE_WINDOWS_SIGNING_THUMBPRINT;
  if (!nonEmpty(cscLink)) problems.push("Windows Authenticode signing requires CSC_LINK");
  if (!nonEmpty(cscPassword)) problems.push("Windows Authenticode signing requires CSC_KEY_PASSWORD");
  if (!nonEmpty(expectedSubject) && !nonEmpty(expectedThumbprint)) {
    problems.push(
      "Windows Authenticode verification requires OPENGROVE_WINDOWS_SIGNING_SUBJECT or OPENGROVE_WINDOWS_SIGNING_THUMBPRINT",
    );
  }
  if (nonEmpty(cscLink) && !cscLink.startsWith("data:") && !isLikelyBase64(cscLink) && !fileExists(cscLink)) {
    problems.push(`CSC_LINK file does not exist: ${cscLink}`);
  }
  return problems;
}

export function windowsSigningConfigPresent(env = process.env) {
  return [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "OPENGROVE_WINDOWS_SIGNING_SUBJECT",
    "OPENGROVE_WINDOWS_SIGNING_THUMBPRINT",
  ].filter((name) => nonEmpty(env[name]));
}

export function macDmgRequiresSigning({ signed, force = false }) {
  return force || !signed;
}

export function resolveReleaseUploadToken({
  env = process.env,
  platform = process.platform,
  execFile = execFileSync,
} = {}) {
  if (nonEmpty(env.OPENGROVE_RELEASE_UPLOAD_TOKEN)) {
    return { token: env.OPENGROVE_RELEASE_UPLOAD_TOKEN.trim(), source: "environment" };
  }
  if (platform !== "darwin") return { token: "", source: "missing" };

  const service = nonEmpty(env.OPENGROVE_RELEASE_UPLOAD_KEYCHAIN_SERVICE)
    ? env.OPENGROVE_RELEASE_UPLOAD_KEYCHAIN_SERVICE.trim()
    : "OpenGrove Release Upload";
  const account = nonEmpty(env.OPENGROVE_RELEASE_UPLOAD_KEYCHAIN_ACCOUNT)
    ? env.OPENGROVE_RELEASE_UPLOAD_KEYCHAIN_ACCOUNT.trim()
    : "ww";
  const keychain = nonEmpty(env.OPENGROVE_RELEASE_UPLOAD_KEYCHAIN)
    ? [env.OPENGROVE_RELEASE_UPLOAD_KEYCHAIN.trim()]
    : [];
  try {
    const token = execFile("security", ["find-generic-password", "-s", service, "-a", account, "-w", ...keychain], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return nonEmpty(token) ? { token, source: "keychain" } : { token: "", source: "missing" };
  } catch {
    return { token: "", source: "missing" };
  }
}

export function resolveR2ReleaseCredentials({
  env = process.env,
  platform = process.platform,
  execFile = execFileSync,
} = {}) {
  const environmentAccessKeyId = trimmed(env.OPENGROVE_RELEASE_R2_ACCESS_KEY_ID);
  const environmentSecretAccessKey = trimmed(env.OPENGROVE_RELEASE_R2_SECRET_ACCESS_KEY);
  if (environmentAccessKeyId || environmentSecretAccessKey) {
    return {
      accessKeyId: environmentAccessKeyId,
      secretAccessKey: environmentSecretAccessKey,
      source: "environment",
    };
  }
  if (platform !== "darwin") {
    return { accessKeyId: "", secretAccessKey: "", source: "missing" };
  }

  const service = trimmed(env.OPENGROVE_RELEASE_R2_KEYCHAIN_SERVICE) || "OpenGrove R2 Release Upload";
  const accessKeyAccount = trimmed(env.OPENGROVE_RELEASE_R2_ACCESS_KEY_KEYCHAIN_ACCOUNT) || "access-key-id";
  const secretKeyAccount = trimmed(env.OPENGROVE_RELEASE_R2_SECRET_KEY_KEYCHAIN_ACCOUNT) || "secret-access-key";
  const keychain = trimmed(env.OPENGROVE_RELEASE_R2_KEYCHAIN);
  const readPassword = (account) => {
    try {
      return execFile(
        "security",
        ["find-generic-password", "-s", service, "-a", account, "-w", ...(keychain ? [keychain] : [])],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      return "";
    }
  };
  const accessKeyId = readPassword(accessKeyAccount);
  const secretAccessKey = readPassword(secretKeyAccount);
  return {
    accessKeyId,
    secretAccessKey,
    source: accessKeyId || secretAccessKey ? "keychain" : "missing",
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isLikelyBase64(value) {
  return value.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}
