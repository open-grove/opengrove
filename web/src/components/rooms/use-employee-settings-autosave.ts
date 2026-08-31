import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomMember } from "./rooms-model";

export type EmployeeSettingsPatchOptions = {
  immediate?: boolean;
};

export function useEmployeeSettingsAutosave(options: {
  member: RoomMember;
  onSave(member: RoomMember): unknown | Promise<unknown>;
  delay?: number;
}) {
  const delay = options.delay ?? 300;
  const saveRef = useRef(options.onSave);
  const sourceMemberRef = useRef(options.member);
  const optimisticMemberRef = useRef(options.member);
  const pendingPatchRef = useRef<Partial<RoomMember>>({});
  const unacknowledgedPatchRef = useRef<Partial<RoomMember>>({});
  const activeDrainRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<number | null>(null);
  const failedRef = useRef(false);
  const mountedRef = useRef(false);
  const drainRef = useRef<() => Promise<boolean>>(async () => true);
  const [member, setMember] = useState(options.member);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  saveRef.current = options.onSave;

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const schedule = useCallback(
    (nextDelay: number) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void drainRef.current();
      }, nextDelay);
    },
    [clearTimer],
  );

  const drain = useCallback(async (): Promise<boolean> => {
    clearTimer();
    if (activeDrainRef.current) return activeDrainRef.current;
    if (failedRef.current || !Object.keys(pendingPatchRef.current).length) {
      return !failedRef.current;
    }

    if (mountedRef.current) setSaving(true);
    const activeDrain = (async () => {
      try {
        while (Object.keys(pendingPatchRef.current).length) {
          const sentPatch = { ...pendingPatchRef.current };
          const memberToSave = { ...optimisticMemberRef.current };
          pendingPatchRef.current = {};
          try {
            await Promise.resolve().then(() => saveRef.current(memberToSave));
          } catch (cause) {
            pendingPatchRef.current = {
              ...sentPatch,
              ...pendingPatchRef.current,
            };
            failedRef.current = true;
            if (mountedRef.current) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
            return false;
          }
          for (const field of Object.keys(sentPatch) as Array<keyof RoomMember>) {
            if (sameSettingValue(unacknowledgedPatchRef.current[field], sentPatch[field])) {
              delete unacknowledgedPatchRef.current[field];
            }
          }
          failedRef.current = false;
          if (mountedRef.current) {
            setError("");
          }
        }
        return true;
      } finally {
        activeDrainRef.current = null;
        if (mountedRef.current) setSaving(false);
      }
    })();

    activeDrainRef.current = activeDrain;
    return activeDrain;
  }, [clearTimer]);
  drainRef.current = drain;

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimer();
    if (failedRef.current) return false;
    return activeDrainRef.current ?? drainRef.current();
  }, [clearTimer]);

  const enqueuePatch = useCallback(
    (patch: Partial<RoomMember>, patchOptions: EmployeeSettingsPatchOptions = {}) => {
      if (!Object.keys(patch).length) return;
      pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
      unacknowledgedPatchRef.current = { ...unacknowledgedPatchRef.current, ...patch };
      const nextMember = { ...optimisticMemberRef.current, ...patch };
      optimisticMemberRef.current = nextMember;
      failedRef.current = false;
      if (mountedRef.current) {
        setMember(nextMember);
        setError("");
      }
      schedule(patchOptions.immediate ? 0 : delay);
    },
    [delay, schedule],
  );

  const retry = useCallback(() => {
    failedRef.current = false;
    if (mountedRef.current) setError("");
    void flush();
  }, [flush]);

  useEffect(() => {
    if (sourceMemberRef.current.id !== options.member.id) return;
    sourceMemberRef.current = options.member;
    const nextMember = {
      ...options.member,
      ...unacknowledgedPatchRef.current,
    };
    optimisticMemberRef.current = nextMember;
    setMember(nextMember);
  }, [options.member]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      void drainRef.current();
    };
  }, [clearTimer]);

  return {
    member,
    saving,
    error,
    enqueuePatch,
    flush,
    retry,
  };
}

function sameSettingValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
