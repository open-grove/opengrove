import { createContext, useContext } from "react";

export const NetworkAuthorizationContext = createContext<{ connect(): Promise<void> } | undefined>(undefined);

/** The application owns the flow; removing a message or dialog does not cancel it. */
export function useNetworkAuthorization() {
  const authorization = useContext(NetworkAuthorizationContext);
  if (!authorization) throw new Error("NetworkAuthorizationProvider is required");
  return authorization;
}
