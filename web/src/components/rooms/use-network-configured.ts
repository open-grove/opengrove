import { useQuery } from "@tanstack/react-query";
import { openGroveClient } from "../../opengrove-client";

/** Configuration discovery never exchanges login credentials or creates a network account. */
export function useNetworkConfigured(): boolean {
  const query = useQuery({
    queryKey: ["network", "configuration"],
    queryFn: () => openGroveClient.network.account.inspect(),
    staleTime: 60_000,
    retry: false,
  });
  return query.data?.configured === true;
}
