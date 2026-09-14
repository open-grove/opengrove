import { useCallback, useLayoutEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { supportedView, type ViewId } from "../bridge";

// React Router owns page history. The existing store keeps the last destination
// as a startup preference and still receives navigation from conversation actions.
export function useAppNavigation(storedView: ViewId, storeView: (view: string) => void) {
  const [params, setParams] = useSearchParams();
  const embedded = params.get("embedded") === "app";
  const activeView = params.has("view") ? supportedView(params.get("view")!) : storedView;
  const previousStoredView = useRef(storedView);
  const setView = useCallback(
    (view: string, appId?: string) => {
      if (embedded) return;
      const next = new URLSearchParams(params);
      const destination = supportedView(view);
      next.set("view", destination);
      if (destination !== activeView || (appId && appId !== params.get("app"))) {
        for (const field of ["room", "member", "file"]) next.delete(field);
      }
      if (destination !== "app") next.delete("app");
      else if (appId) next.set("app", appId);
      if (next.toString() !== params.toString()) void setParams(next);
    },
    [activeView, embedded, params, setParams],
  );
  useLayoutEffect(() => {
    // Embedded App URLs belong to their containing host, not shell navigation.
    if (embedded) return;
    if (!params.has("view")) {
      const next = new URLSearchParams(params);
      next.set("view", storedView);
      void setParams(next, { replace: true });
      return;
    }
    if (previousStoredView.current !== storedView) {
      previousStoredView.current = storedView;
      if (storedView !== activeView) setView(storedView);
    } else if (storedView !== activeView) storeView(activeView);
  }, [activeView, embedded, params, setParams, setView, storedView, storeView]);
  return { activeView, setView, requestedAppId: activeView === "app" ? (params.get("app") ?? "") : "" };
}
