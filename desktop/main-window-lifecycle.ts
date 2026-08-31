export interface MainWindowLifecycleTarget {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export function focusOrCreateMainWindow<TWindow extends MainWindowLifecycleTarget>(
  current: TWindow | undefined,
  create: () => TWindow | undefined,
): TWindow | undefined {
  if (current && !current.isDestroyed()) {
    if (current.isMinimized()) current.restore();
    current.focus();
    return current;
  }

  const replacement = create();
  if (!replacement || replacement.isDestroyed()) return replacement;
  if (replacement.isMinimized()) replacement.restore();
  replacement.focus();
  return replacement;
}

export function clearClosedMainWindow<TWindow>(current: TWindow | undefined, closed: TWindow): TWindow | undefined {
  return current === closed ? undefined : current;
}

export function activateBridgeInRetainedMainWindow(markBridgeReady: () => void): void {
  // VS Code and GitHub Desktop keep window readiness separate from service
  // readiness. Publishing the new service state must never replace the loaded
  // renderer document; recovery UI and in-memory work stay mounted.
  markBridgeReady();
}
