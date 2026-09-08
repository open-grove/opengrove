import type { ChildProcess } from "node:child_process";

/** Sending a signal does not mean the child has exited or released its locks. */
export async function stopDesktopBridgeChild(
  child: ChildProcess,
  options: { gracefulTimeoutMs?: number; forceTimeoutMs?: number } = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      if (forceTimer) clearTimeout(forceTimer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = (error: Error) => finish(error);
    const signal = (value: NodeJS.Signals) => {
      if (settled) return;
      try {
        if (!child.kill(value) && child.exitCode === null && child.signalCode === null) {
          finish(new Error(`desktop_bridge_signal_failed:${child.pid}:${value}`));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const graceTimer = setTimeout(() => {
      forceTimer = setTimeout(
        () => finish(new Error(`desktop_bridge_exit_timeout:${child.pid}`)),
        options.forceTimeoutMs ?? 2_500,
      );
      signal("SIGKILL");
    }, options.gracefulTimeoutMs ?? 2_500);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.connected) {
      try {
        child.send({ type: "opengrove.desktop.bridge.shutdown" }, (error) => {
          if (error) signal("SIGTERM");
        });
      } catch {
        // IPC race: retry shutdown through a signal if the channel closed.
        signal("SIGTERM");
      }
    } else {
      signal("SIGTERM");
    }
  });
}
