import { useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { openGroveClient } from "../opengrove-client";

const APP_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;

export function useAppUpdateChecks(input: { authenticated: boolean; userId?: string; automatic: boolean }) {
  const { mutate } = useMutation({
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
    const timer = setInterval(scheduleAppUpdates, APP_UPDATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [input.authenticated, input.userId, input.automatic, scheduleAppUpdates]);

  // Login/session restoration owns the initial check. Re-enabling calls this
  // only after settings are saved; the optimistic toggle must not send a POST.
  return scheduleAppUpdates;
}
