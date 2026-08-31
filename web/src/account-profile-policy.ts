import type { BridgeAuthUser } from "./bridge-settings-types";

export type AccountProfileLoadAction = "use-remote" | "use-cache" | "migrate-cache";

export function accountProfileLoadAction(
  user: Pick<BridgeAuthUser, "profileStatus" | "profileUpdatedAt">,
  hasCachedProfile: boolean,
): AccountProfileLoadAction {
  if (user.profileStatus === "unavailable") return "use-cache";
  if (user.profileStatus === "available" || user.profileUpdatedAt) return "use-remote";
  return hasCachedProfile ? "migrate-cache" : "use-cache";
}
