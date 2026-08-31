import type { EventsResponse } from "../bridge";

export function mergeAgentEventPage(
  previous: EventsResponse | undefined,
  page: EventsResponse,
  maxCachedEvents = 2_000,
): EventsResponse {
  const events = page.snapshot || !previous ? page.events : [...previous.events, ...page.events];
  return {
    ...page,
    events: events.slice(-Math.max(1, maxCachedEvents)),
  };
}
