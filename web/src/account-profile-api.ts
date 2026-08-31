import { patchJson } from "./bridge-client";
import type { BridgeAuthUser } from "./bridge-settings-types";

export interface UpdateAccountProfileInput {
  displayName?: string | null;
  avatarDataUrl?: string | null;
}

export async function updateAccountProfile(input: UpdateAccountProfileInput): Promise<BridgeAuthUser> {
  const response = await patchJson<{ user: BridgeAuthUser }>("/auth/profile", input);
  return response.user;
}
