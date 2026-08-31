import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EventsResponse } from "../bridge";
import { bridgeHeaders, fetchJson } from "../bridge";
import { mergeAgentEventPage } from "./agent-event-sync";

const EVENT_SNAPSHOT_LIMIT = 200;
const EVENT_DELTA_LIMIT = 200;
const MAX_CACHED_EVENTS = 2_000;
const MAX_CATCH_UP_PAGES = 10;

export function useAgentEventsQuery(input: {
  enabled: boolean;
  scopeKey: string;
  runId?: string;
  runIds?: string[];
  refetchInterval: number | false;
  longPoll?: boolean;
  legacyServerMinimumIntervalMs?: number;
}) {
  const queryClient = useQueryClient();
  const runIds = [
    ...new Set(
      [...(input.runIds ?? []), ...(input.runId ? [input.runId] : [])].map((value) => value.trim()).filter(Boolean),
    ),
  ].sort();
  const queryKey =
    input.runId && input.runIds === undefined
      ? (["events", input.scopeKey, "run", input.runId] as const)
      : runIds.length
        ? (["events", input.scopeKey, "runs", runIds.join("\u0000")] as const)
        : (["events", input.scopeKey] as const);

  return useQuery<EventsResponse>({
    queryKey,
    enabled: input.enabled,
    refetchInterval: (query) => {
      const response = query.state.data;
      if (input.legacyServerMinimumIntervalMs && response?.longPollSupported !== true) {
        return input.legacyServerMinimumIntervalMs;
      }
      return input.refetchInterval;
    },
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }): Promise<EventsResponse> => {
      const previous = queryClient.getQueryData<EventsResponse>(queryKey);
      const waitForEvents = Boolean(previous?.cursor) && input.longPoll === true;
      let response = await fetchEventPage({
        cursor: previous?.cursor,
        runIds,
        signal,
        waitForEvents,
      });
      if (response.resetRequired) {
        response = await fetchEventPage({ runIds, signal });
      }

      let accumulated = mergeAgentEventPage(previous, response, MAX_CACHED_EVENTS);
      let pages = 1;
      while (response.hasMore && pages < MAX_CATCH_UP_PAGES) {
        response = await fetchEventPage({ cursor: accumulated.cursor, runIds, signal });
        if (response.resetRequired) {
          response = await fetchEventPage({ runIds, signal });
          accumulated = mergeAgentEventPage(undefined, response, MAX_CACHED_EVENTS);
          break;
        }
        accumulated = mergeAgentEventPage(accumulated, response, MAX_CACHED_EVENTS);
        pages += 1;
      }

      return {
        ...accumulated,
        snapshot: false,
      };
    },
  });
}

async function fetchEventPage(input: {
  cursor?: string;
  runIds: string[];
  signal: AbortSignal;
  waitForEvents?: boolean;
}): Promise<EventsResponse> {
  const params = new URLSearchParams({
    limit: String(input.cursor === undefined ? EVENT_SNAPSHOT_LIMIT : EVENT_DELTA_LIMIT),
  });
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  for (const runId of input.runIds) params.append("runId", runId);
  if (input.waitForEvents) params.set("waitMs", "25000");
  return fetchJson<EventsResponse>(`/events?${params.toString()}`, {
    headers: bridgeHeaders(false),
    signal: input.signal,
  });
}
