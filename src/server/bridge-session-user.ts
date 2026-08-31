export interface BridgeSessionUser {
  userId: string;
  email: string;
  countryCode?: string;
  displayName: string;
  avatarUrl?: string;
  profileUpdatedAt?: string;
  profileStatus?: "available" | "missing" | "unavailable";
  role: string;
  roles?: string[];
}
