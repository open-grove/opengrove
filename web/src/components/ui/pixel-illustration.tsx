export type PixelIllustrationName = "grove" | "sprout" | "messages";

const DEFAULT_SIZE = 96;

export function PixelIllustration(props: { name: PixelIllustrationName; size?: number; className?: string }) {
  const size = props.size ?? DEFAULT_SIZE;
  return (
    <svg
      viewBox="0 0 96 96"
      width={size}
      height={size}
      aria-hidden="true"
      shapeRendering="crispEdges"
      className={props.className}
    >
      {props.name === "grove" ? <GroveArt /> : null}
      {props.name === "sprout" ? <SproutArt /> : null}
      {props.name === "messages" ? <MessagesArt /> : null}
    </svg>
  );
}

function GroveArt() {
  return (
    <g>
      {/* ground */}
      <rect x="8" y="84" width="80" height="4" fill="var(--c-border-strong)" />
      {/* big tree, center */}
      <rect x="40" y="16" width="16" height="8" fill="var(--og-sapling-highlight)" />
      <rect x="32" y="24" width="32" height="8" fill="var(--og-sapling-green)" />
      <rect x="28" y="32" width="40" height="8" fill="var(--og-sapling-green)" />
      <rect x="36" y="40" width="24" height="8" fill="var(--og-sapling-shade)" />
      <rect x="44" y="48" width="8" height="36" fill="var(--og-sapling-trunk)" />
      <rect x="48" y="48" width="4" height="36" fill="var(--og-sapling-trunk-highlight)" />
      {/* small sapling, left */}
      <rect x="16" y="48" width="12" height="8" fill="var(--og-sapling-highlight)" />
      <rect x="12" y="56" width="20" height="8" fill="var(--og-sapling-green)" />
      <rect x="20" y="64" width="4" height="20" fill="var(--og-sapling-trunk)" />
      {/* medium tree, right */}
      <rect x="68" y="36" width="16" height="8" fill="var(--og-sapling-highlight)" />
      <rect x="64" y="44" width="24" height="8" fill="var(--og-sapling-green)" />
      <rect x="68" y="52" width="16" height="4" fill="var(--og-sapling-shade)" />
      <rect x="72" y="56" width="4" height="28" fill="var(--og-sapling-trunk)" />
    </g>
  );
}

function SproutArt() {
  return (
    <g>
      {/* seedling */}
      <rect x="46" y="36" width="4" height="30" fill="var(--og-sapling-green)" />
      <rect x="30" y="32" width="16" height="8" fill="var(--og-sapling-highlight)" />
      <rect x="34" y="28" width="8" height="4" fill="var(--og-sapling-highlight)" />
      <rect x="50" y="26" width="16" height="8" fill="var(--og-sapling-green)" />
      <rect x="54" y="22" width="8" height="4" fill="var(--og-sapling-green)" />
      {/* pot */}
      <rect x="30" y="66" width="36" height="8" fill="var(--og-sapling-trunk)" />
      <rect x="34" y="74" width="28" height="12" fill="var(--og-sapling-trunk)" />
      <rect x="34" y="74" width="4" height="12" fill="var(--og-sapling-trunk-highlight)" />
      {/* ground */}
      <rect x="20" y="86" width="56" height="4" fill="var(--c-border-strong)" />
    </g>
  );
}

function MessagesArt() {
  return (
    <g>
      {/* back bubble */}
      <rect x="12" y="18" width="40" height="24" fill="var(--c-border-strong)" />
      <rect x="16" y="42" width="8" height="8" fill="var(--c-border-strong)" />
      {/* front bubble */}
      <rect x="36" y="46" width="44" height="24" fill="var(--og-sapling-green)" />
      <rect x="68" y="70" width="8" height="8" fill="var(--og-sapling-green)" />
      <rect x="44" y="56" width="6" height="6" fill="var(--og-white)" />
      <rect x="55" y="56" width="6" height="6" fill="var(--og-white)" />
      <rect x="66" y="56" width="6" height="6" fill="var(--og-white)" />
    </g>
  );
}
