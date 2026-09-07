import { useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { openGroveClient } from "../opengrove-client";

const APP_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;

export function useAppUpdateChecks(input: { authenticated: boolean; userId?: string; automatic: boolean }) {
  const { mutate } = useMutation({
    mutationKey: ["app-update-schedule", input.userId],
    mutationFn: () => openGroveClient.apps.updates.schedule(),
    retry: false,
    onError: (error) => {
      console.warn("app_update_schedule_failed", error);
    },
  });
  const scheduleAppUpdates = useCallback(() => {
    if (input.authenticated && input.userId) mutate();
  }, [input.authenticated, input.userId, mutate]);

  useEffect(() => {
    if (!input.authenticated || !input.userId || !input.automatic) return;
    scheduleAppUpdates();
    const timer = setInterval(scheduleAppUpdates, APP_UPDATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [input.authenticated, input.userId, input.automatic, scheduleAppUpdates]);

  // Re-enabling App updates calls this after the settings save has reset the
  // server cursor, even if an optimistic UI update already started a check.
  return scheduleAppUpdates;
}
