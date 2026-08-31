import type { KernelOption } from "../../bridge";
import type { SettingsSectionId } from "./settings-sections";

const STANDARD_SETTINGS_SECTION_IDS = new Set<SettingsSectionId>([
  "mode",
  "kernels",
  "appearance",
  "desktop",
  "updates",
]);

export function isSettingsSectionVisible(sectionId: SettingsSectionId, developerMode: boolean): boolean {
  return developerMode || STANDARD_SETTINGS_SECTION_IDS.has(sectionId);
}

export function visibleKernelOptions(kernels: KernelOption[], _developerMode: boolean): KernelOption[] {
  return kernels;
}
