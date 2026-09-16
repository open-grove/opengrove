import { z } from "zod";

// Host HTTP behavior before the Protocol migration (OpenGrove 0.7.0, #107):
// https://github.com/open-grove/opengrove/issues/107
// Older Hosts omit the long-poll capability; consumers must keep periodic refresh.
// Remove this default only when those Host versions are no longer supported.
export const hostLongPollSupportSchema = z.boolean().optional().default(false);
