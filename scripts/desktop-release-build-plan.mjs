export function macArchitectureBuildPlan({ baseBuilderArgs, arch, version, deferNotarization }) {
  const archFlag = arch === "arm64" ? "--arm64" : arch === "x64" ? "--x64" : "";
  if (!archFlag) throw new Error(`Unsupported macOS release architecture: ${arch}`);

  return {
    builderArgs: ["electron-builder", ...baseBuilderArgs, "--mac", archFlag, ...(deferNotarization ? ["--dir"] : [])],
    artifactFiles: deferNotarization
      ? []
      : ["dmg", "zip", "dmg.blockmap", "zip.blockmap"].map(
          (extension) => `OpenGrove-${version}-mac-${arch}.${extension}`,
        ),
  };
}
