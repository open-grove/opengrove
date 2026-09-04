import type { OpenGroveDesktopApi } from "../desktop-api";

type DesktopBootstrapApi = Pick<OpenGroveDesktopApi, "bridgeStartupState" | "getBridgeStartupState">;
type DesktopBridgeStartupState = NonNullable<DesktopBootstrapApi["bridgeStartupState"]>;

export function resolveBridgeReadyGenerationTransition(
  previousGeneration: number | undefined,
  state: DesktopBridgeStartupState | undefined,
): { generation: number | undefined; restarted: boolean } {
  if (state?.stage !== "ready") {
    return { generation: previousGeneration, restarted: false };
  }
  return {
    generation: state.generation,
    restarted: previousGeneration !== undefined && state.generation !== previousGeneration,
  };
}

export function desktopBridgeReadyForBootstrap(desktop: DesktopBootstrapApi | undefined): boolean {
  if (!desktop) return true;
  return (desktop.getBridgeStartupState?.() ?? desktop.bridgeStartupState)?.stage === "ready";
}

export function desktopBridgeRequiresStartupGate(desktop: DesktopBootstrapApi | undefined): boolean {
  if (!desktop) return false;
  const stage = (desktop.getBridgeStartupState?.() ?? desktop.bridgeStartupState)?.stage;
  return stage !== "ready" && stage !== "maintenance";
}
