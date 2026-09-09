import { useCallback } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

// Page details share the router's history, while peer tabs and dialogs retain
// their own component semantics. A directly opened detail always has a list exit.
export function usePageDetail(field: "room" | "member" | "file") {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const detailId = params.get(field) ?? "";
  const showDetail = useCallback(
    (id: string, replace = false) => {
      if (!id || id === detailId) return;
      const next = new URLSearchParams(params);
      next.set(field, id);
      void setParams(next, { replace, state: { detailListReturn: detailId ? null : field } });
    },
    [detailId, field, params, setParams],
  );
  const clearDetail = useCallback(() => {
    if (!detailId) return;
    const next = new URLSearchParams(params);
    next.delete(field);
    void setParams(next, { replace: true });
  }, [detailId, field, params, setParams]);
  const showList = useCallback(() => {
    if (!detailId) return;
    if (location.state?.detailListReturn === field) {
      void navigate(-1);
      return;
    }
    clearDetail();
  }, [clearDetail, detailId, field, location.state, navigate]);
  return { detailId, showDetail, showList, clearDetail };
}
