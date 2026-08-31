const nativeSessionQueues = new Map<string, Promise<void>>();

export async function runWithNativeSessionLock<T>(
  namespace: string,
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = `${namespace}:${sessionId}`;
  const previous = nativeSessionQueues.get(key);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = (previous ?? Promise.resolve()).catch(() => undefined).then(() => gate);
  nativeSessionQueues.set(key, queued);

  if (previous) {
    await previous.catch(() => undefined);
  }

  try {
    return await task();
  } finally {
    release();
    if (nativeSessionQueues.get(key) === queued) {
      nativeSessionQueues.delete(key);
    }
  }
}
