export type SafeJsonValue = string | number | boolean | null | SafeJsonValue[] | { [key: string]: SafeJsonValue };

export const SAFE_JSON_CIRCULAR_MARKER = "[omitted circular reference]";
export const SAFE_JSON_DEPTH_MARKER = "[omitted beyond depth limit]";
export const SAFE_JSON_NODE_MARKER = "[omitted after node limit]";
export const SAFE_JSON_UNREADABLE_MARKER = "[omitted unreadable property]";
export const DEFAULT_SAFE_JSON_MAX_DEPTH = 64;
export const DEFAULT_SAFE_JSON_MAX_NODES = Number.POSITIVE_INFINITY;

export interface SafeJsonLimits {
  maxDepth?: number;
  maxNodes?: number;
}

export interface SafeJsonValueOptions extends SafeJsonLimits {
  omitUndefinedProperties?: boolean;
  stringifyUnsupported?: boolean;
  transformString?: (value: string, key: string) => string;
}

export interface SafeJsonVisit {
  value: unknown;
  key?: string;
  depth: number;
}

export type SafeJsonVisitor = (entry: SafeJsonVisit) => boolean | void;

interface SafeJsonState {
  ancestors: WeakSet<object>;
  exhausted: boolean;
  maxDepth: number;
  maxNodes: number;
  nodes: number;
  options: SafeJsonValueOptions;
}

export function toSafeJsonValue(value: unknown, options: SafeJsonValueOptions = {}): SafeJsonValue {
  const state: SafeJsonState = {
    ancestors: new WeakSet(),
    exhausted: false,
    maxDepth: positiveInteger(options.maxDepth, DEFAULT_SAFE_JSON_MAX_DEPTH),
    maxNodes: positiveInteger(options.maxNodes, DEFAULT_SAFE_JSON_MAX_NODES),
    nodes: 0,
    options,
  };
  return normalizeJsonValue(value, "", 0, state);
}

export function visitSafeJsonValues(value: unknown, visitor: SafeJsonVisitor, limits: SafeJsonLimits = {}): void {
  const maxDepth = positiveInteger(limits.maxDepth, DEFAULT_SAFE_JSON_MAX_DEPTH);
  const maxNodes = positiveInteger(limits.maxNodes, DEFAULT_SAFE_JSON_MAX_NODES);
  const seen = new WeakSet<object>();
  const stack: SafeJsonVisit[] = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0 && nodes < maxNodes) {
    const entry = stack.pop();
    if (!entry) break;
    const isObject = Boolean(entry.value) && typeof entry.value === "object";
    if (isObject) {
      const object = entry.value as object;
      if (seen.has(object)) continue;
      seen.add(object);
    }

    nodes += 1;
    let visitChildren: boolean | void;
    try {
      visitChildren = visitor(entry);
    } catch {
      // Hostile Proxy getters are isolated per node so the bounded traversal can inspect the remaining value safely.
      continue;
    }
    if (visitChildren === false || !isObject || entry.depth >= maxDepth) continue;

    let isArray = false;
    try {
      isArray = Array.isArray(entry.value);
    } catch {
      // non-critical-fallback: A Proxy may throw during the array brand check; treat that single node as opaque.
      continue;
    }
    if (isArray) {
      const length = readSafeArrayLength(entry.value as unknown[]);
      if (length === undefined) continue;
      const childCount = Math.min(length, maxNodes - nodes - stack.length);
      for (let index = childCount - 1; index >= 0; index -= 1) {
        stack.push({
          value: readSafeProperty(entry.value as unknown[], index),
          depth: entry.depth + 1,
        });
      }
      continue;
    }

    const children: Array<[string, unknown]> = [];
    const childCapacity = maxNodes - nodes - stack.length;
    if (childCapacity > 0) {
      const keys = readSafeKeys(entry.value as object);
      if (!keys) continue;
      for (const key of keys) {
        children.push([key, readSafeProperty(entry.value as Record<string, unknown>, key)]);
        if (children.length >= childCapacity) break;
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (!child) continue;
      stack.push({ key: child[0], value: child[1], depth: entry.depth + 1 });
    }
  }
}

function normalizeJsonValue(value: unknown, key: string, depth: number, state: SafeJsonState): SafeJsonValue {
  if (state.exhausted || state.nodes >= state.maxNodes) {
    state.exhausted = true;
    return SAFE_JSON_NODE_MARKER;
  }
  state.nodes += 1;

  if (typeof value === "string") {
    return state.options.transformString?.(value, key) ?? value;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value || typeof value !== "object") {
    return state.options.stringifyUnsupported ? safeString(value) : null;
  }
  if (depth >= state.maxDepth) {
    return SAFE_JSON_DEPTH_MARKER;
  }
  if (state.ancestors.has(value)) {
    return SAFE_JSON_CIRCULAR_MARKER;
  }

  state.ancestors.add(value);
  try {
    let isArray = false;
    try {
      isArray = Array.isArray(value);
    } catch {
      return SAFE_JSON_UNREADABLE_MARKER;
    }
    if (isArray) {
      const output: SafeJsonValue[] = [];
      const length = readSafeArrayLength(value as unknown[]);
      if (length === undefined) return SAFE_JSON_UNREADABLE_MARKER;
      for (let index = 0; index < length; index += 1) {
        const child = readSafeProperty(value as unknown[], index);
        output.push(normalizeJsonValue(child, "", depth + 1, state));
        if (state.exhausted) break;
      }
      return output;
    }

    const output: Record<string, SafeJsonValue> = {};
    const keys = readSafeKeys(value);
    if (!keys) return SAFE_JSON_UNREADABLE_MARKER;
    for (const childKey of keys) {
      const child = readSafeProperty(value as Record<string, unknown>, childKey);
      if (child === undefined && state.options.omitUndefinedProperties) continue;
      output[childKey] = normalizeJsonValue(child, childKey, depth + 1, state);
      if (state.exhausted) break;
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function readSafeKeys(value: object): string[] | undefined {
  try {
    return Object.keys(value);
  } catch {
    return undefined;
  }
}

function readSafeProperty(value: Record<string, unknown> | unknown[], key: string | number): unknown {
  try {
    return value[key as never];
  } catch {
    return SAFE_JSON_UNREADABLE_MARKER;
  }
}

function readSafeArrayLength(value: unknown[]): number | undefined {
  try {
    const length = value.length;
    return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return SAFE_JSON_UNREADABLE_MARKER;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
