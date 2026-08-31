import type { RailSectionId } from "../../apps/catalog";
import type { ViewId } from "../../bridge";

export function developerOnlyView(view: ViewId): boolean {
  return view === "extensions";
}

export function developerOnlyRailSection(section: RailSectionId): boolean {
  return section === "extensions";
}

export function nativeRailSectionVisible(
  section: RailSectionId,
  developerMode: boolean,
  directKernelChatEnabled = false,
): boolean {
  if (section === "chat") return directKernelChatEnabled;
  return developerMode || section === "rooms";
}
