import { useLayoutEffect, useRef, type SyntheticEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { usePageDetail } from "../../runtime/use-page-detail";
import { useCompactLayout } from "../../runtime/use-compact-layout";
import styles from "./compact-list-detail.module.css";
import paneStyles from "./adaptive-split-layout.module.css";

export function useCompactDetail(field: "room" | "member") {
  const compact = useCompactLayout();
  const { detailId, showDetail, showList } = usePageDetail(field);
  const detailOpen = Boolean(detailId);
  const listRef = useRef<HTMLElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const previousDetail = useRef(detailOpen);
  useLayoutEffect(() => {
    if (!compact || previousDetail.current === detailOpen) return;
    previousDetail.current = detailOpen;
    if (detailOpen) detailRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    else if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
  }, [compact, detailOpen]);
  return {
    compact,
    className: styles.root,
    listRef,
    detailRef,
    detailOpen,
    detailId,
    rememberListTarget: (event: SyntheticEvent<HTMLElement>) => {
      if (event.target instanceof Element)
        returnFocus.current = event.target.closest<HTMLElement>("button, [role=button], input, [tabindex]");
    },
    showDetail,
    showList,
  };
}

export function CompactBackButton(props: { label: string; onClick(): void }) {
  return (
    <button className={`compact-detail-back ${paneStyles.back}`} type="button" onClick={props.onClick}>
      <ArrowLeft size={18} aria-hidden="true" />
      {props.label}
    </button>
  );
}
