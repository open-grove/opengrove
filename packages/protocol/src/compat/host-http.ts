import { z } from "zod";

// Host HTTP behavior before the Protocol migration (OpenGrove 0.7.0, #107):
// https://github.com/open-grove/opengrove/issues/107
// Older Hosts omit the long-poll capability; consumers must keep periodic refresh.
// Remove this default only when those Host versions are no longer supported.
export const hostLongPollSupportSchema = z.boolean().optional().default(false);

// These GET endpoints used URLSearchParams.get and their own number readers in
// Host 0.7.0. Preserve first-value, fallback, floor and cap behavior during #107.
// Remove only with an explicitly versioned HTTP contract change.
const firstValue = { "x-opengrove-query-repeated": "first" };
const numericQuery = z.union([z.number(), z.string()]).optional();

export function roomQueryInteger(fallback: number, maximum = Infinity) {
  return numericQuery
    .transform((value) => {
      if (value === undefined || value === "") return fallback;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), maximum) : fallback;
    })
    .meta(firstValue);
}

export const roomQueryCursor = numericQuery
  .transform((value) => {
    if (value === undefined || value === "") return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
  })
  .meta(firstValue);

export function stateQueryLimit(fallback: number, maximum: number) {
  return numericQuery
    .transform((value) => {
      const number = Number(value);
      return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
    })
    .describe(`Defaults to ${fallback}; values above ${maximum} are capped; invalid values use the default.`)
    .meta(firstValue);
}

export const eventQueryLimit = numericQuery
  .transform((value) => {
    const number = Number(value ?? 200);
    return Number.isSafeInteger(number) ? Math.max(1, Math.min(number, 1000)) : 200;
  })
  .meta(firstValue);

export const hostQueryWaitMs = numericQuery
  .transform((value) => {
    const number = Number(value ?? 0);
    return Number.isSafeInteger(number) && number > 0 ? Math.min(number, 25000) : 0;
  })
  .describe("Maximum long-poll wait; capped at 25000 ms. Invalid or nonpositive values do not wait.")
  .meta(firstValue);

export function hostQueryFilter<T extends z.ZodEnum>(values: T) {
  return z
    .string()
    .optional()
    .transform((value): z.output<T> | undefined => {
      const parsed = values.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    })
    .meta(firstValue);
}
