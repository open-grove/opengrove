import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useCompactLayout } from "../../runtime/use-compact-layout";
import styles from "./compact-list-detail.module.css";
import paneStyles from "./adaptive-split-layout.module.css";

export function useCompactDetail(initialDetail = false) {
  const compact = useCompactLayout();
  const [detailOpen, setDetailOpen] = useState(initialDetail);
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
    showDetail: () => {
      if (document.activeElement instanceof HTMLElement && listRef.current?.contains(document.activeElement))
        returnFocus.current = document.activeElement;
      setDetailOpen(true);
    },
    showList: () => setDetailOpen(false),
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
