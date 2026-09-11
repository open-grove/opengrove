import { useQuery } from "@tanstack/react-query";
import { openGroveClient } from "../../opengrove-client";

export interface NetworkConfiguration {
  status: "loading" | "error" | "unconfigured" | "configured";
  retry(): void;
}

/** Configuration discovery never exchanges login credentials or creates a network account. */
export function useNetworkConfiguration(): NetworkConfiguration {
  const query = useQuery({
    queryKey: ["network", "configuration"],
    queryFn: () => openGroveClient.network.account.inspect(),
    staleTime: 60_000,
    retry: false,
  });
  return {
    status: query.data
      ? query.data.configured
        ? "configured"
        : "unconfigured"
      : query.isFetching || !query.isError
        ? "loading"
        : "error",
    retry: () => {
      void query.refetch();
    },
  };
}
