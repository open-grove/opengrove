import { useCallback, useEffect, useState } from "react";
import type { ReasoningEffort, ResponseSpeed, RuntimeAccessMode } from "./bridge";
import { APP_STORAGE_KEYS } from "./identity";
import {
  readStoredBudgetLimitUsd,
  readStoredRailExpanded,
  readStoredReasoningEffort,
  readStoredResponseSpeed,
} from "./runtime/app-shell-state";
import { readStoredAccessMode } from "./runtime/ui-model";

export type RoomsAppView = "messages" | "contacts";

const ROOMS_ACTIVE_ROOM_STORAGE_KEY = "opengrove.rooms.activeRoomId";

export function useAppPersistentUiState(activeView: string) {
  const [roomsAppView, setRoomsAppViewState] = useState<RoomsAppView>(() => readStoredRoomsAppView());
  const [roomsFocusRoomId, setRoomsFocusRoomIdState] = useState(() => readStoredRoomsFocusRoomId());
  const [roomsOnboardingGuideDismissed, setRoomsOnboardingGuideDismissed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(APP_STORAGE_KEYS.roomsOnboardingGuide) === "dismissed",
  );
  const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort>(() => readStoredReasoningEffort());
  const [responseSpeed, setResponseSpeedState] = useState<ResponseSpeed>(() => readStoredResponseSpeed());
  const [budgetLimitUsd, setBudgetLimitUsdState] = useState<number | null>(() => readStoredBudgetLimitUsd());
  const [accessMode, setAccessModeState] = useState<RuntimeAccessMode>(() => readStoredAccessMode());
  const [railExpanded, setRailExpandedState] = useState(readStoredRailExpanded);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarRevealArmed, setSidebarRevealArmed] = useState(true);

  const setRoomsAppView = useCallback((view: RoomsAppView) => {
    setRoomsAppViewState(view);
    writeStoredRoomsAppView(view);
  }, []);
  const setRoomsFocusRoomId = useCallback((roomId: string) => {
    const normalized = roomId.trim();
    setRoomsFocusRoomIdState(normalized);
    writeStoredRoomsFocusRoomId(normalized);
  }, []);
  const clearRoomsSelection = useCallback(() => {
    setRoomsFocusRoomIdState("");
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(APP_STORAGE_KEYS.roomsLastRoomId);
    window.localStorage.removeItem(ROOMS_ACTIVE_ROOM_STORAGE_KEY);
  }, []);

  useEffect(() => {
    if (activeView === "contacts") {
      setRoomsAppView("contacts");
    } else if (activeView === "rooms") {
      setRoomsAppView("messages");
    }
  }, [activeView, setRoomsAppView]);

  function setAccessMode(value: RuntimeAccessMode) {
    setAccessModeState(value);
    window.localStorage.setItem(APP_STORAGE_KEYS.accessMode, value);
  }

  function setReasoningEffort(value: ReasoningEffort) {
    setReasoningEffortState(value);
    window.localStorage.setItem(APP_STORAGE_KEYS.reasoningEffort, value);
  }

  function setResponseSpeed(value: ResponseSpeed) {
    setResponseSpeedState(value);
    window.localStorage.setItem(APP_STORAGE_KEYS.responseSpeed, value);
  }

  function setBudgetLimitUsd(value: number | null) {
    setBudgetLimitUsdState(value);
    if (value && value > 0) {
      window.localStorage.setItem(APP_STORAGE_KEYS.budgetLimitUsd, String(value));
    } else {
      window.localStorage.removeItem(APP_STORAGE_KEYS.budgetLimitUsd);
    }
  }

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(APP_STORAGE_KEYS.sidebarCollapsed, String(next));
      setSidebarRevealArmed(!next);
      return next;
    });
  }

  function setRailExpanded(expanded: boolean) {
    setRailExpandedState(expanded);
    window.localStorage.setItem(APP_STORAGE_KEYS.railExpanded, String(expanded));
  }

  return {
    accessMode,
    budgetLimitUsd,
    clearRoomsSelection,
    railExpanded,
    reasoningEffort,
    responseSpeed,
    roomsAppView,
    roomsFocusRoomId,
    roomsOnboardingGuideDismissed,
    setAccessMode,
    setBudgetLimitUsd,
    setRailExpanded,
    setReasoningEffort,
    setResponseSpeed,
    setRoomsAppView,
    setRoomsFocusRoomId,
    setRoomsOnboardingGuideDismissed,
    setSidebarRevealArmed,
    sidebarCollapsed,
    sidebarRevealArmed,
    toggleSidebarCollapsed,
  };
}

function readStoredRoomsAppView(): RoomsAppView {
  if (typeof window === "undefined") return "messages";
  return window.localStorage.getItem(APP_STORAGE_KEYS.roomsLastView) === "contacts" ? "contacts" : "messages";
}

function writeStoredRoomsAppView(view: RoomsAppView): void {
  window.localStorage.setItem(APP_STORAGE_KEYS.roomsLastView, view);
}

function readStoredRoomsFocusRoomId(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(APP_STORAGE_KEYS.roomsLastRoomId)?.trim() ?? "";
}

function writeStoredRoomsFocusRoomId(roomId: string): void {
  const normalized = roomId.trim();
  if (normalized) {
    window.localStorage.setItem(APP_STORAGE_KEYS.roomsLastRoomId, normalized);
  } else {
    window.localStorage.removeItem(APP_STORAGE_KEYS.roomsLastRoomId);
  }
}
