export interface DesktopStorageMaintenanceOperation<T> {
  acquire(): Promise<string>;
  run(leaseId: string): Promise<T>;
  release(leaseId: string): Promise<void>;
  onReleased?(): void;
  onReleaseError?(error: unknown): void;
}

export async function runDesktopStorageMaintenance<T>(operation: DesktopStorageMaintenanceOperation<T>): Promise<T> {
  const leaseId = await operation.acquire();
  let runFailed = false;
  try {
    return await operation.run(leaseId);
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    try {
      await operation.release(leaseId);
      operation.onReleased?.();
    } catch (error) {
      if (!runFailed) throw error;
      try {
        operation.onReleaseError?.(error);
      } catch {
        // The original cleanup failure remains the actionable diagnostic.
      }
    }
  }
}
