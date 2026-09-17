// npm logs are untrusted and may contain credentials. Export selected metrics,
// never raw log text, arbitrary URLs, configuration or command lines.
const timerPattern =
  /^(?:reify[A-Za-z]*|idealTree|build|command:install|npm|arborist)(?::[A-Za-z][\w.-]*)*(?::node_modules(?:\/[a-zA-Z0-9@_.-]+)+)?$/;
export function summarizeNpmDiagnostics(logTexts, timingTexts = []) {
  const events = [];
  const timers = new Map();
  const unfinished = new Set();
  let incompleteTimingReports = 0;
  for (const text of logTexts) {
    for (const line of text.split(/\r?\n/)) {
      const fetch = /http fetch (GET|POST|PUT|DELETE) (\d{3}) (\S+) (\d+)ms/.exec(line);
      if (fetch) {
        let resource = "external-registry";
        try {
          const url = new URL(fetch[3]);
          if (url.hostname === "registry.npmjs.org" && !url.username && !url.password) resource = url.pathname;
        } catch {
          /* Malformed URLs remain redacted. */
        }
        events.push({
          type: "fetch",
          method: fetch[1],
          status: Number(fetch[2]),
          resource,
          durationMs: Number(fetch[4]),
        });
      }
      const timer = /timing (\S+) Completed in (\d+)ms/.exec(line);
      if (timer && timerPattern.test(timer[1])) {
        timers.set(timer[1], Number(timer[2]));
        events.push({ type: "timer", name: timer[1], durationMs: Number(timer[2]) });
      }
      const lifecycle =
        /info run ((?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@[\w.+-]+) (preinstall|install|postinstall) node_modules[\/\\]/.exec(
          line,
        );
      if (lifecycle) events.push({ type: "lifecycle", package: lifecycle[1], phase: lifecycle[2] });
    }
  }
  for (const text of timingTexts) {
    try {
      const report = JSON.parse(text);
      for (const [name, duration] of Object.entries(report.timers ?? {})) {
        if (timerPattern.test(name) && Number.isFinite(duration) && duration >= 0) timers.set(name, duration);
      }
      for (const name of Object.keys(report.unfinishedTimers ?? {})) if (timerPattern.test(name)) unfinished.add(name);
    } catch {
      incompleteTimingReports++;
    }
  }
  return {
    events: events.slice(-50),
    longestTimers: [...timers]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, durationMs]) => ({ name, durationMs })),
    unfinishedTimers: [...unfinished].slice(0, 50),
    incompleteTimingReports,
  };
}
