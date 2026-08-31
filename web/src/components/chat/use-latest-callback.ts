import { useCallback, useEffect, useRef } from "react";

// 让父组件每次 render 都会新建的事件回调获得稳定引用（供 memo 化子组件使用），
// 同时始终调用最新一版，避免过期闭包；回调缺省（undefined）时保持缺省语义。
export function useLatestCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R;
export function useLatestCallback<A extends unknown[], R>(
  callback: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined;
export function useLatestCallback<A extends unknown[], R>(
  callback: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined {
  const ref = useRef(callback);
  useEffect(() => {
    ref.current = callback;
  });
  const stable = useCallback((...args: A) => ref.current?.(...args) as R, []);
  return callback ? stable : undefined;
}
