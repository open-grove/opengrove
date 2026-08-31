import type { BridgeState } from "./bridge-types.js";

const taskTails = new WeakMap<BridgeState, Promise<void>>();

/** Serialize background Store mutations so policy installs and automatic updates cannot race. */
export function runBackgroundAppStoreTask<T>(state: BridgeState, task: () => Promise<T>): Promise<T> {
  const previous = taskTails.get(state) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  taskTails.set(state, tail);
  void tail.then(() => {
    if (taskTails.get(state) === tail) taskTails.delete(state);
  });
  return run;
}
