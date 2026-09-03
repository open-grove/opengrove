import type { OpenGroveDesktopApi } from "../desktop-api";

type DesktopBootstrapApi = Pick<OpenGroveDesktopApi, "bridgeStartupState" | "getBridgeStartupState">;

export function desktopBridgeReadyForBootstrap(desktop: DesktopBootstrapApi | undefined): boolean {
  if (!desktop) return true;
  return (desktop.getBridgeStartupState?.() ?? desktop.bridgeStartupState)?.stage === "ready";
}

export function desktopBridgeRequiresStartupGate(desktop: DesktopBootstrapApi | undefined): boolean {
  if (!desktop) return false;
  const stage = (desktop.getBridgeStartupState?.() ?? desktop.bridgeStartupState)?.stage;
  return stage !== "ready" && stage !== "maintenance";
}
