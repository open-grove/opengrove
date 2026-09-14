import { basename, isAbsolute, relative, sep } from "node:path";
import { queryWindowsCommand, type WindowsCommandQuery } from "../../environment/windows-discovery.js";

// Windows package discovery boundary for desktop installs without a CLI entry.
// OpenAI uses this stable package identity across Codex/ChatGPT branding:
// https://github.com/openai/codex/blob/main/codex-rs/cli/src/desktop_app/windows.rs
// Remove this package-internal lookup when the desktop app guarantees a public
// CLI entry point. Do not pin a versioned WindowsApps directory or copy its files.
const PACKAGE_CODEX_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$package = Get-AppxPackage -Name OpenAI.Codex |
  Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' } |
  Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $package) { exit 0 }
$executables = @(Get-ChildItem -LiteralPath $package.InstallLocation -Filter codex.exe -File -Recurse |
  Sort-Object { $_.FullName.Length }, FullName | Select-Object -ExpandProperty FullName)
@{ installLocation = $package.InstallLocation; executables = $executables } | ConvertTo-Json -Compress
`;

export function windowsAppCodexCandidates(
  environment: NodeJS.ProcessEnv,
  query: WindowsCommandQuery = queryWindowsCommand,
): string[] {
  const output = query(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PACKAGE_CODEX_QUERY],
    environment,
  );
  if (!output?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(output.replace(/^\uFEFF/, ""));
  } catch {
    console.warn("[windows-discovery] Codex app query returned invalid JSON");
    return [];
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("installLocation" in value) ||
    !("executables" in value) ||
    typeof value.installLocation !== "string" ||
    !isAbsolute(value.installLocation) ||
    !Array.isArray(value.executables)
  ) {
    console.warn("[windows-discovery] Codex app query returned invalid package metadata");
    return [];
  }
  const root = value.installLocation;
  return value.executables.filter((candidate): candidate is string => {
    if (
      typeof candidate !== "string" ||
      candidate.includes("\0") ||
      !isAbsolute(candidate) ||
      basename(candidate).toLowerCase() !== "codex.exe"
    )
      return false;
    const subpath = relative(root, candidate);
    return subpath !== ".." && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath);
  });
}
