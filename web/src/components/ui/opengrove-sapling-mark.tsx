export function OpenGroveSaplingMark() {
  return (
    <svg viewBox="0 0 128 128" aria-hidden="true" shapeRendering="crispEdges">
      <g transform="translate(24 18) scale(0.72)">
        <rect
          data-sapling-part="leaf-highlight"
          x="0"
          y="0"
          width="31"
          height="31"
          fill="var(--og-sapling-highlight)"
        />
        <rect data-sapling-part="leaf" x="16" y="16" width="31" height="31" fill="var(--og-sapling-green)" />
        <rect
          data-sapling-part="leaf-highlight"
          x="79"
          y="15"
          width="31"
          height="31"
          fill="var(--og-sapling-highlight)"
        />
        <rect data-sapling-part="leaf" x="63" y="31" width="31" height="31" fill="var(--og-sapling-green)" />
        <rect data-sapling-part="trunk" x="47" y="47" width="17" height="58" fill="var(--og-sapling-trunk)" />
        <rect data-sapling-part="trunk" x="60" y="47" width="4" height="58" fill="var(--og-sapling-trunk-highlight)" />
        <rect data-sapling-part="base" x="32" y="105" width="47" height="15" fill="var(--og-sapling-trunk)" />
        <rect data-sapling-part="base" x="32" y="105" width="47" height="3" fill="var(--og-sapling-trunk-highlight)" />
      </g>
    </svg>
  );
}
