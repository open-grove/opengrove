import { useEffect, useState, type CSSProperties } from "react";
import { NameAvatar } from "./name-avatar";

/**
 * 员工头像：seed（通常用员工 id）确定性生成 Notionists 插画脸。
 * 本地纯函数生成，无网络请求；同一 seed 永远同脸，换 seed 即换脸。
 * 用 img 加载 SVG data URI，让每个头像拥有独立 SVG 文档，避免 mask id 串台。
 */
const EMPLOYEE_AVATAR_CACHE_LIMIT = 128;
const employeeAvatarDataUriCache = new Map<string, string>();
const pendingEmployeeAvatarDataUris = new Map<string, Promise<string>>();
let employeeAvatarGeneratorPromise: Promise<(seed: string) => string> | undefined;

/**
 * 同一个逻辑员工可能同时存在“全局定义”和“App/会话绑定”，两者的 member id
 * 可以不同，但 employeeDefinitionId 相同。头像必须优先使用逻辑定义 id，
 * 才能保证通讯录、聊天、标题栏和 App 内嵌聊天显示同一张脸。
 */
export function employeeAvatarSeedForMember(member: { id: string; employeeDefinitionId?: string }): string {
  return member.employeeDefinitionId?.trim() || member.id.trim() || "opengrove-employee";
}

export async function employeeAvatarDataUri(seed: string): Promise<string> {
  const normalizedSeed = seed.trim() || "opengrove-employee";
  const cached = readCachedEmployeeAvatar(normalizedSeed);
  if (cached) return cached;
  const pending = pendingEmployeeAvatarDataUris.get(normalizedSeed);
  if (pending) return pending;
  const generation = loadEmployeeAvatarGenerator()
    .then((generate) => {
      const dataUri = generate(normalizedSeed);
      cacheEmployeeAvatar(normalizedSeed, dataUri);
      return dataUri;
    })
    .finally(() => pendingEmployeeAvatarDataUris.delete(normalizedSeed));
  pendingEmployeeAvatarDataUris.set(normalizedSeed, generation);
  return generation;
}

export function useEmployeeAvatarDataUri(seed: string, enabled = true): string {
  const normalizedSeed = seed.trim() || "opengrove-employee";
  const [src, setSrc] = useState(() => (enabled ? (readCachedEmployeeAvatar(normalizedSeed) ?? "") : ""));

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setSrc("");
      return () => {
        cancelled = true;
      };
    }
    const cached = readCachedEmployeeAvatar(normalizedSeed);
    if (cached) {
      setSrc(cached);
      return () => {
        cancelled = true;
      };
    }
    setSrc("");
    void employeeAvatarDataUri(normalizedSeed)
      .then((dataUri) => {
        if (!cancelled) setSrc(dataUri);
      })
      .catch(() => {
        // NameAvatar remains visible when the optional generated asset fails.
        if (!cancelled) setSrc("");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, normalizedSeed]);

  return src;
}

export function EmployeeAvatar(props: {
  seed: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  fallbackName?: string;
}) {
  const size = props.size ?? 32;
  const src = useEmployeeAvatarDataUri(props.seed);

  const style: CSSProperties = {
    display: "block",
    width: size,
    height: size,
    borderRadius: "50%",
    flex: "none",
    background: "var(--c-surface-hover)",
    objectFit: "cover",
    ...props.style,
  };

  return (
    <NameAvatar
      name={props.fallbackName || props.seed}
      value={props.seed}
      src={src}
      size={size}
      className={props.className}
      title={props.title}
      style={style}
    />
  );
}

async function loadEmployeeAvatarGenerator(): Promise<(seed: string) => string> {
  if (!employeeAvatarGeneratorPromise) {
    employeeAvatarGeneratorPromise = import("./employee-avatar-notionists")
      .then((module) => module.generateEmployeeAvatarDataUri)
      .catch((error) => {
        employeeAvatarGeneratorPromise = undefined;
        throw error;
      });
  }
  return employeeAvatarGeneratorPromise;
}

function readCachedEmployeeAvatar(seed: string): string | undefined {
  const cached = employeeAvatarDataUriCache.get(seed);
  if (!cached) return undefined;
  employeeAvatarDataUriCache.delete(seed);
  employeeAvatarDataUriCache.set(seed, cached);
  return cached;
}

function cacheEmployeeAvatar(seed: string, dataUri: string) {
  employeeAvatarDataUriCache.delete(seed);
  employeeAvatarDataUriCache.set(seed, dataUri);
  while (employeeAvatarDataUriCache.size > EMPLOYEE_AVATAR_CACHE_LIMIT) {
    const oldestSeed = employeeAvatarDataUriCache.keys().next().value;
    if (typeof oldestSeed !== "string") break;
    employeeAvatarDataUriCache.delete(oldestSeed);
  }
}
