export const windowsPowerShellExecutable = "powershell.exe";

export function sanitizedWindowsPowerShellEnv(baseEnv = process.env, overrides = {}) {
  const env = { ...baseEnv, ...overrides };
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === "psmodulepath") delete env[name];
  }
  return env;
}
