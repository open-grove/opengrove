export const OVERLAY_SURFACE_SIZES = ["compact", "content", "regular", "wide", "picker", "preserve"] as const;

export type OverlaySurfaceSize = (typeof OVERLAY_SURFACE_SIZES)[number];
export type BoundedOverlaySurfaceSize = Exclude<OverlaySurfaceSize, "preserve">;
