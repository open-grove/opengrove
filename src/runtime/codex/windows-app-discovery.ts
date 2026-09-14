import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  readWindowsQuery,
  refreshWindowsQuery,
  type WindowsCommandQuery,
  type WindowsEnvironmentProbe,
} from "../../environment/windows-query.js";

// Windows package discovery boundary for desktop installs without a CLI entry.
// OpenAI uses this stable package identity across Codex/ChatGPT branding:
// https://github.com/openai/codex/blob/f5a3dc55404ddc066a4e4a65602fee166ecc46b3/codex-rs/cli/src/doctor/desktop/platform.rs#L152
// Remove this package-internal lookup when the desktop app guarantees a public
// CLI entry point. Do not pin a versioned WindowsApps directory or copy its files.
const PACKAGE_CODEX_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$package = Get-AppxPackage -Name OpenAI.Codex |
  Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' } |
  Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $package) { exit 0 }
$manifest = Get-AppxPackageManifest -Package $package.PackageFullName
$desktopExecutables = @($manifest.Package.Applications.Application | ForEach-Object {
  if ($_.Executable) { Join-Path $package.InstallLocation $_.Executable }
})
$scanErrors = @()
$executables = @(Get-ChildItem -LiteralPath $package.InstallLocation -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue -ErrorVariable +scanErrors |
  Sort-Object { $_.FullName.Length }, FullName | Select-Object -ExpandProperty FullName)
@{ installLocation = $package.InstallLocation; executables = $executables; desktopExecutables = $desktopExecutables; unreadableEntries = $scanErrors.Count } | ConvertTo-Json -Compress
`;

const PACKAGE_CODEX_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PACKAGE_CODEX_QUERY];

export function windowsAppCodexCandidates(environment: NodeJS.ProcessEnv, query?: WindowsCommandQuery): string[] {
  return parseWindowsAppCandidates(readWindowsQuery(PACKAGE_CODEX_ARGS, environment, query));
}

export async function refreshWindowsAppCodexCandidates(
  environment: NodeJS.ProcessEnv,
  probe: WindowsEnvironmentProbe = {},
): Promise<string[]> {
  const output = await refreshWindowsQuery(PACKAGE_CODEX_ARGS, environment, probe, 5 * 60_000);
  return parseWindowsAppCandidates(output);
}

function parseWindowsAppCandidates(output: string | undefined): string[] {
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
    !("desktopExecutables" in value) ||
    typeof value.installLocation !== "string" ||
    !isAbsolute(value.installLocation) ||
    !Array.isArray(value.executables) ||
    !Array.isArray(value.desktopExecutables) ||
    !value.desktopExecutables.every((candidate) => typeof candidate === "string")
  ) {
    console.warn("[windows-discovery] Codex app query returned invalid package metadata");
    return [];
  }
  const root = value.installLocation;
  if ("unreadableEntries" in value && typeof value.unreadableEntries === "number" && value.unreadableEntries > 0) {
    console.warn(`[windows-discovery] Codex package scan skipped ${value.unreadableEntries} unreadable entries`);
  }
  // The desktop launcher may also be named Codex.exe. Its package manifest
  // identifies it without depending on the current app branding or layout.
  const desktopExecutables = new Set(
    value.desktopExecutables.map((candidate: string) => resolve(candidate).toLowerCase()),
  );
  return value.executables.filter((candidate): candidate is string => {
    if (
      typeof candidate !== "string" ||
      candidate.includes("\0") ||
      !isAbsolute(candidate) ||
      basename(candidate).toLowerCase() !== "codex.exe" ||
      desktopExecutables.has(resolve(candidate).toLowerCase())
    )
      return false;
    const subpath = relative(root, candidate);
    return subpath !== ".." && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath);
  });
}
