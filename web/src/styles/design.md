---
version: 0.1.0-alpha
name: OpenGrove Design System
description: >-
  Canonical token contract and design intent for the OpenGrove web workspace.
  The frontmatter is the source of truth for the semantic layer, global scales,
  and legacy CSS aliases listed here. src/styles/tokens.css is the CSS
  implementation and must stay in sync with this file; when the two disagree,
  tokens.css is implementation drift. The ~760 unique component-scoped tokens
  (--composer-*, --rooms-*, …) live only in tokens.css until they are promoted.

# ── Color ──────────────────────────────────────────────────────────────
# Two layers: raw atoms (--og-*) and semantic roles (--c-*). Components must
# reference the SEMANTIC roles, never raw atoms or new literals. Light values
# are listed first; the `dark` value is the [data-resolved-theme="dark"] override.
colors:
  # Raw/supporting atoms that are still referenced by live CSS.
  white: { light: "oklch(100% 0 0)", dark: "oklch(100% 0 0)" } # --og-white
  canvas: { light: "oklch(98.781% 0.0013 106.42)", dark: "oklch(23.852% 0.0037 106.68)" } # --og-canvas
  # A sidebar is not a tonal step of its own: the conversation and contacts
  # sidebars and the member panel are the same paper as the content, and the canvas
  # seam between panels is what separates them (see Layering). The app rail is not
  # here — it belongs to the frame and paints nothing.
  sidebar-bg: { ref: "{colors.surface}" } # --og-sidebar-bg, sidebars are the same paper as content

  # Brand atoms — identity, not general UI.
  brand-green: { light: "oklch(55.966% 0.1292 156.01)", dark: "oklch(73.422% 0.1336 145.14)" } # OpenGrove identity + true success
  auth-entry-brand: { light: "oklch(55.966% 0.1292 156.01)", dark: "oklch(55.966% 0.1292 156.01)" } # fixed brand green on the intentionally light-only auth entry
  interaction-blue: { light: "oklch(65.862% 0.1669 250.73)", dark: "oklch(73.853% 0.1333 252.97)" } # the ONE interaction blue (see Colors note)
  sapling-green: { light: "oklch(68.791% 0.1625 139.68)", dark: "oklch(68.791% 0.1625 139.68)" } # --og-sapling-green
  sapling-highlight: { light: "oklch(76.545% 0.1708 137.07)", dark: "oklch(76.545% 0.1708 137.07)" } # --og-sapling-highlight
  sapling-shade: { light: "oklch(63.657% 0.1618 143.38)", dark: "oklch(63.657% 0.1618 143.38)" } # --og-sapling-shade
  sapling-trunk: { light: "oklch(25.625% 0.0058 196.79)", dark: "oklch(25.625% 0.0058 196.79)" } # --og-sapling-trunk
  sapling-trunk-highlight: { light: "oklch(34.205% 0.0088 173.82)", dark: "oklch(34.205% 0.0088 173.82)" } # --og-sapling-trunk-highlight

  # Surfaces (background → raised cards → sunken wells).
  # The canvas is the app frame, and in light mode it is the only place a step can
  # come from: paper is pinned at 100%, so the seam between frame and paper is worth
  # exactly (100% − this value). The light frame keeps a quiet seam around white
  # sheets without turning the window into a large grey slab. Its near-neutral cool
  # cast follows macOS window chrome and is intentionally too small to read as colour.
  bg: { light: "oklch(97.941% 0.0013 286.38)", dark: "oklch(23.852% 0.0037 106.68)" } # --c-bg, the app canvas — rgb(248,248,249)
  surface: { light: "oklch(100% 0 0)", dark: "oklch(28.019% 0.0036 106.63)" } # --c-surface, active workspace sheet
  surface-hover: { light: "oklch(96.715% 0 0)", dark: "oklch(31.708% 0.0054 91.55)" } # --c-surface-hover — rgb(244,244,244)
  surface-active: { light: "oklch(94.787% 0.0025 228.79)", dark: "oklch(33.640% 0.0070 95.27)" } # --c-surface-active
  # Grouped is a persistent, large-area surface. In light mode it stays close to
  # paper; in dark mode it keeps the existing active step that already reads well.
  surface-grouped: { light: "oklch(97.614% 0 0)", dark: "oklch(33.640% 0.0070 95.27)" } # --c-surface-grouped — rgb(247,247,247)
  surface-raised: { light: "oklch(100% 0 0)", dark: "oklch(28.019% 0.0036 106.63)" } # --c-surface-raised, popovers above canvas
  # surface-sunken is a STRUCTURAL step, not a wash: it must stay far enough from
  # the paper it is cut into that the block reads as recessed without a hairline.
  # It is measured against surface, not bg — panels are all paper (see Layering),
  # so the only thing sitting on this colour is a block recessed INTO a panel.
  # The existing light value is already Δ0.039 from surface. Legacy consumers
  # outside this structural role should migrate to a fill instead of tuning this
  # shared token and changing unrelated screens.
  surface-sunken: { light: "oklch(96.095% 0.0029 264.54)", dark: "oklch(21.700% 0.0038 106.71)" } # --c-surface-sunken, blocks recessed into a panel
  popover: { ref: "{colors.surface-raised}" } # floating menu/dropdown surface
  # popover-solid: GUARANTEED opaque popover base. Identical to popover today, but
  # kept distinct so a future scenic/glass mode (translucent popover) still has a
  # solid layer behind text for legibility. Always 100% opaque — never alpha.
  popover-solid: { ref: "{colors.surface-raised}" }

  # Fills — TRANSLUCENT tints of the foreground, for anything that sits INSIDE a
  # surface: filled containers on a sheet, input wells, filled controls. Because
  # a fill is relative to whatever it is painted on, it can never come out the
  # same color as its parent — which is the failure mode that kills a container
  # the moment its hairline is removed. Opaque steps are for structure (canvas /
  # sheet / recessed panel) and are budgeted; fills are for everything nested
  # inside one and cost no budget. fill-strong is the hover/active step of a fill.
  fill: { light: "oklch(from {colors.text} l c h / 0.05)", dark: "oklch(from {colors.text} l c h / 0.07)" } # --c-fill
  fill-strong: { light: "oklch(from {colors.text} l c h / 0.09)", dark: "oklch(from {colors.text} l c h / 0.12)" } # --c-fill-strong

  # Text (strong → muted → faint).
  text-strong: { light: "oklch(21.008% 0.0318 264.66)", dark: "oklch(93.110% 0.0153 90.24)" } # --og-text-strong
  text: { light: "oklch(24.371% 0.0059 271.17)", dark: "oklch(87.287% 0.0126 91.53)" } # --c-text, primary copy
  text-2: { light: "oklch(37.851% 0.0110 264.44)", dark: "oklch(82.384% 0.0145 88.70)" } # --c-text-2, secondary
  text-3: { ref: "{colors.text-muted}" } # --c-text-3, legacy muted alias
  text-muted: { light: "oklch(55.148% 0.0100 264.49)", dark: "oklch(72.587% 0.0136 86.85)" } # --c-muted
  text-faint: { light: "oklch(56.000% 0.0094 264.50)", dark: "oklch(66.000% 0.0129 84.59)" } # --c-faint, metadata/placeholders — WCAG AA ≥4.5:1 on surface in both themes

  # Borders & hairlines.
  border: { light: "oklch(from {colors.text} l c h / 0.08)", dark: "oklch(from {colors.text-strong} l c h / 0.12)" } # --c-border
  border-strong: { light: "oklch(from {colors.text} l c h / 0.12)", dark: "oklch(from {colors.text-strong} l c h / 0.2)" } # --c-border-strong
  overlay-ink: { light: "oklch(0% 0 0)", dark: "oklch(0% 0 0)" } # --c-overlay-ink, shadow/scrim ink source
  overlay-highlight: { light: "oklch(100% 0 0)", dark: "oklch(100% 0 0)" } # --c-overlay-highlight, inverse/highlight overlay source

  # Semantic accents & state. Accent = interaction (selection, focus, primary,
  # live work). Success/warning/error are rare signals — neutral until meaningful.
  accent: { ref: "{colors.interaction-blue}" } # --c-accent
  accent-hover: { light: "oklch(60.421% 0.1570 251.07)", dark: "oklch(79.968% 0.1039 252.12)" } # --c-accent-hover
  # accent-solid: deeper brand blue for FILLED accent backgrounds behind white
  # text (primary buttons). --c-accent stays the text/link/selection blue; only
  # use accent-solid as a background — white on it is ≥4.5:1 in both themes.
  accent-solid: { light: "oklch(56.000% 0.1600 250.73)", dark: "oklch(56.000% 0.1600 250.73)" } # --c-accent-solid
  accent-soft: { light: "color-mix(in srgb, {colors.accent} 10%, {colors.bg})", dark: "color-mix(in srgb, {colors.accent} 16%, {colors.bg})" } # --c-accent-soft, tinted bg
  focus-ring: { light: "oklch(from {colors.text} l c h / 0.25)", dark: "oklch(from {colors.text} l c h / 0.25)" } # --c-focus-ring
  success: { light: "oklch(55.966% 0.1292 156.01)", dark: "oklch(73.422% 0.1336 145.14)" } # --c-success
  # unread-solid: Telegram blue's perceived-lightness/chroma relationship rotated
  # into green. This is a notification-count role, not success or brand identity.
  # It remains fixed across themes so one unread count has one recognizable color.
  unread-solid: { light: "#4EB279", dark: "#4EB279" } # --c-unread-solid
  unread-ink: { light: "{colors.white}", dark: "#081015" } # --c-unread-ink, numeral on notification-count fills
  warning: { light: "oklch(54.334% 0.1190 59.54)", dark: "oklch(80.665% 0.1258 74.03)" } # --c-warning
  error: { light: "oklch(50.034% 0.1821 29.51)", dark: "oklch(74.172% 0.1312 34.58)" } # --c-error
  auth-entry-error: { light: "oklch(50.034% 0.1821 29.51)", dark: "oklch(50.034% 0.1821 29.51)" } # fixed AA error text on the light-only auth entry
  # error-solid: a solid red for badges/unread dots that must read as a filled
  # marker (the deeper --c-error reads as text/border, too dark for a dot).
  # Deep enough that white label text on it is ≥4.5:1 (WCAG AA).
  error-solid: { light: "oklch(58.000% 0.2000 25.33)", dark: "oklch(58.000% 0.2000 25.33)" } # --c-error-solid
  link: { light: "oklch(54.615% 0.2152 262.88)", dark: "oklch(73.853% 0.1333 252.97)" } # --c-link — see Colors note re: second blue
  link-strong: { light: "oklch(48.820% 0.2172 264.38)", dark: "oklch(79.968% 0.1039 252.12)" } # --c-link-strong
  violet: { light: "oklch(54.134% 0.2466 293.01)", dark: "oklch(73.680% 0.1420 299.36)" } # --c-violet, skill/app accent
  success-soft: { light: "color-mix(in srgb, {colors.success} 8%, {colors.bg})", dark: "color-mix(in srgb, {colors.success} 16%, {colors.bg})" } # --c-success-soft
  error-soft: { light: "color-mix(in srgb, {colors.error} 8%, {colors.bg})", dark: "color-mix(in srgb, {colors.error} 16%, {colors.bg})" } # --c-error-soft
  warning-soft: { light: "color-mix(in srgb, {colors.warning} 8%, {colors.bg})", dark: "color-mix(in srgb, {colors.warning} 16%, {colors.bg})" } # --c-warning-soft

  # Section/sidebar aliases used by the current app shell.
  section-text: { light: "color-mix(in srgb, {colors.text} 92%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 92%, {colors.bg})" } # --og-section-text
  section-title: { light: "color-mix(in srgb, {colors.text} 50%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 50%, {colors.bg})" } # --og-section-title
  section-muted: { ref: "{colors.section-title}" } # --og-section-muted
  section-icon: { light: "color-mix(in srgb, {colors.text} 62%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 70%, {colors.bg})" } # --og-section-icon
  # Row hover/active are the same two fill steps as everything else — the app has
  # one fill scale, not a sidebar dialect (see Layering).
  section-hover: { ref: "{colors.fill}" } # --og-section-hover
  section-active: { ref: "{colors.fill-strong}" } # --og-section-active
  section-border: { light: "oklch(from {colors.text} l c h / 0.06)", dark: "oklch(from {colors.text} l c h / 0.12)" } # --og-section-border

  # Neutral scale (100 = lightest surface … 900 = darkest text). Each step is
  # derived from the theme's text/bg endpoints so grey UI surfaces move together
  # when either endpoint changes.
  neutral-100: { light: "color-mix(in srgb, {colors.text} 0.78%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 8.85%, {colors.bg})" }
  neutral-200: { light: "color-mix(in srgb, {colors.text} 5.95%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 13.11%, {colors.bg})" }
  neutral-300: { light: "color-mix(in srgb, {colors.text} 13.93%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 20.12%, {colors.bg})" }
  neutral-400: { light: "color-mix(in srgb, {colors.text} 28.95%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 30.66%, {colors.bg})" }
  neutral-500: { light: "color-mix(in srgb, {colors.text} 47.11%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 51.13%, {colors.bg})" }
  neutral-600: { light: "color-mix(in srgb, {colors.text} 66.83%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 74.19%, {colors.bg})" }
  neutral-700: { light: "color-mix(in srgb, {colors.text} 84.66%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 91.16%, {colors.bg})" }
  neutral-800: { light: "color-mix(in srgb, {colors.text} 96.72%, {colors.bg})", dark: "color-mix(in srgb, {colors.text} 100%, {colors.bg})" }
  # neutral-900 is an independent cold near-black (#111217), NOT a mix of
  # text-strong: a 100% mix is meaningless (= text-strong, which is warmer) and
  # drifts ~18 from the original. Kept as an explicit endpoint, zero drift.
  neutral-900: { light: "oklch(18.343% 0.0103 276.41)", dark: "oklch(93.110% 0.0153 90.24)" }

  # Translucent hairlines/dividers derived from the current foreground.
  line-04: { light: "oklch(from {colors.text} l c h / 0.04)", dark: "oklch(from {colors.text} l c h / 0.04)" }
  line-06: { light: "oklch(from {colors.text} l c h / 0.055)", dark: "oklch(from {colors.text} l c h / 0.06)" }
  line-08: { light: "oklch(from {colors.text} l c h / 0.08)", dark: "oklch(from {colors.text} l c h / 0.1)" }
  line-12: { light: "oklch(from {colors.text} l c h / 0.12)", dark: "oklch(from {colors.text} l c h / 0.16)" }
  overlay-scrim: { light: "oklch(from {colors.text} l c h / 0.45)", dark: "oklch(0% 0 0 / 0.55)" }

# TEMPORARY compatibility variables — migration crutches, not permanent contract.
# Each is a second name for a semantic role above (e.g. og-surface == surface).
# The component-token cleanup now prevents new literals; alias deletion is a
# separate source-compat cleanup because many component CSS files still consume
# these names directly. Do NOT add to this list.
aliases:
  og-app-bg: "{colors.bg}"
  og-surface: "{colors.surface}"
  og-surface-subtle: "{colors.surface-hover}"
  og-surface-muted: "{colors.surface-active}"
  og-surface-grouped: "{colors.surface-grouped}"
  og-text: "{colors.text}"
  og-text-muted: "{colors.text-muted}"
  og-text-soft: "{colors.text-faint}"
  og-border: "{colors.border}"
  og-border-strong: "{colors.border-strong}"
  og-accent: "{colors.accent}"
  og-accent-hover: "{colors.accent-hover}"
  og-accent-soft: "{colors.accent-soft}"
  og-focus-ring: "{colors.focus-ring}"
  og-green: "{colors.brand-green}"
  og-brand: "{colors.brand-green}"
  og-interaction: "{colors.accent}"
  og-success: "{colors.success}"
  paper-board: "{colors.bg}"
  paper-board-soft: "{colors.surface-hover}"
  paper-sheet: "{colors.surface}"
  paper-line: "{colors.border}"
  paper-line-strong: "{colors.border-strong}"
  paper-shadow: "none"
  paper-radius: "{rounded.lg}"
  surface: "{colors.surface}"
  text: "{colors.text}"
  text-2: "{colors.text-2}"
  muted: "{colors.text-muted}"
  border: "{colors.border}"
  codex-accent: "{colors.accent}"

# ── Typography ─────────────────────────────────────────────────────────
typography:
  fontFamily:
    sans: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif'
    mono: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace'
  fontWeight:
    normal: 400 # --fw-normal
    medium: 500 # --fw-medium
    semibold: 600 # --fw-semibold
    bold: 600 # --fw-bold, compatibility alias only; do not introduce a fourth visible weight
  # A compact fixed ramp. Legacy token names stay available, but the visible
  # scale is deliberately collapsed to six sizes: 11 / 12 / 14 / 16 / 20 / 24.
  # Operational tools earn polish from surface, spacing, and state,
  # not from many type sizes. No geometric ratio, no separate reading size, no
  # tracking. Component token font sizes are linted back to this scale.
  fontSize:
    "2xs": 11px # --fs-2xs, compatibility alias for micro text; resolves to xs
    xs: 11px # --fs-xs, meta/timestamps
    sm: 12px # --fs-sm, dense UI text, code
    base: 14px # --fs-base, compatibility alias for default body; resolves to md
    md: 14px # --fs-md, default UI body
    lg: 16px # --fs-lg, section titles
    xl: 20px # --fs-xl, panel/dialog titles
    "2xl": 24px # --fs-2xl, subsection hero / metric
    "3xl": 24px # --fs-3xl, compatibility alias for the maximum display size
  lineHeight:
    tight: 1.25 # --lh-tight, headings/labels
    normal: 1.45 # --lh-normal, default dense UI body
    relaxed: 1.6 # --lh-relaxed, long-form documents/threads
  letterSpacing: "0" # keep at 0 everywhere — no tracking, including display sizes

# ── Spacing (4px base, 2px resolution below 16px) ──────────────────────
# Resolution falls off as values grow: the eye reads ratios, so 6px vs 8px is a
# visible 33% step while 40px vs 42px is 5% and reads as noise. Half steps
# therefore exist only below {spacing.4}; at and above it the scale stays on the
# 4px grid. Odd values are never tokens — snap them to the nearest step.
spacing:
  "0-5": 2px # --sp-0-5, hairline insets, icon/badge padding, tightest chip gap
  "1": 4px
  "1-5": 6px # --sp-1-5
  "2": 8px
  "2-5": 10px # --sp-2-5
  "3": 12px
  "3-5": 14px # --sp-3-5
  "4": 16px # last step with a half step below it
  "5": 20px
  "6": 24px
  "7": 28px
  "8": 32px
  "9": 36px
  "10": 40px

# ── Radius ─────────────────────────────────────────────────────────────
rounded:
  none: 0 # --r-none, full-bleed surfaces (knowledge/workspace/preview)
  xs: 5px # --r-xs
  sm: 8px # --r-sm
  md: 10px # --r-md, default control radius (buttons, inputs)
  lg: 12px # --r-lg, cards/paper
  xl: 22px # --r-xl
  "2xl": 24px # --r-2xl
  pill: 999px # --r-pill, avatars/dots/toggles

# ── Elevation ──────────────────────────────────────────────────────────
# Layered, not single-cast. Each level is a 1px border RING (foreground color at
# low alpha — keeps the edge crisp) plus cascading black blur layers whose
# opacity falls off as they spread. Two knobs scale the whole system and rise in
# dark mode so shadows stay visible on dark surfaces. Prefer a tonal surface step
# before reaching for elevation at all.
elevation:
  # Control knobs — every shadow's opacity derives from these.
  border-opacity: { light: 0.06, dark: 0.15 } # the 1px ring alpha (uses foreground color)
  blur-opacity: { light: 0.06, dark: 0.12 } # base blur alpha; distant layers scale down
  # hairline — barely-there separation. Ring only.
  hairline: { light: "0 0 0 1px rgba(17,24,39,0.04)", dark: "0 0 0 1px rgba(236,232,221,0.06)" }
  # sm — rows, raised list items, resting controls. Ring + 2 close blur layers.
  sm:
    light: "0 0 0 1px rgba(17,24,39,0.06), 0 1px 1px -0.5px rgba(0,0,0,0.06), 0 3px 3px -1.5px rgba(0,0,0,0.06)"
    dark: "0 0 0 1px rgba(236,232,221,0.15), 0 1px 1px -0.5px rgba(0,0,0,0.12), 0 3px 3px -1.5px rgba(0,0,0,0.12)"
  # md — popovers, dropdowns, menus. Ring + cascading blur (1→3→6→12px, fading).
  md:
    light: "0 0 0 1px rgba(17,24,39,0.06), 0 1px 1px -0.5px rgba(0,0,0,0.04), 0 3px 3px rgba(0,0,0,0.04), 0 6px 6px rgba(0,0,0,0.02), 0 12px 12px rgba(0,0,0,0.02)"
    dark: "0 0 0 1px rgba(236,232,221,0.15), 0 1px 1px -0.5px rgba(0,0,0,0.08), 0 3px 3px rgba(0,0,0,0.08), 0 6px 6px rgba(0,0,0,0.04), 0 12px 12px rgba(0,0,0,0.04)"
  # lg — dialogs, modals. Ring + full cascade out to 24px.
  lg:
    light: "0 0 0 1px rgba(17,24,39,0.06), 0 1px 2px rgba(0,0,0,0.04), 0 6px 12px rgba(0,0,0,0.04), 0 12px 24px rgba(0,0,0,0.03), 0 24px 48px rgba(0,0,0,0.03)"
    dark: "0 0 0 1px rgba(236,232,221,0.15), 0 1px 2px rgba(0,0,0,0.10), 0 6px 12px rgba(0,0,0,0.08), 0 12px 24px rgba(0,0,0,0.06), 0 24px 48px rgba(0,0,0,0.06)"
  # flat — the ring alone, no blur. For quiet separation (resting cards, wells).
  flat: { light: "0 0 0 1px rgba(17,24,39,0.06)", dark: "0 0 0 1px rgba(236,232,221,0.15)" }

# ── Motion ─────────────────────────────────────────────────────────────
# Motion is OFF by default and only used to explain a change (see Motion prose).
# Durations stay short (≤260ms) so the app feels instant, not animated.
motion:
  # stagger: per-item offset for sequential reveals (disclosure panels), not a standalone duration.
  # spin: loop period for continuous loading spinners (the shared `@keyframes spin`
  # in reset.css). Exempt from the ≤260ms rule — it is a repeating indicator, not
  # a state transition.
  duration: { instant: 90ms, fast: 120ms, normal: 180ms, slow: 260ms, stagger: 28ms, spin: 800ms }
  easing:
    standard: "cubic-bezier(0.4, 0, 0.2, 1)" # --motion-ease, color/state changes
    out: "cubic-bezier(0, 0, 0.2, 1)" # --motion-ease-out, simple exits
    entrance: "cubic-bezier(0.22, 1, 0.36, 1)" # soft landing — things settle in, used for reveals

# ── Z-index ────────────────────────────────────────────────────────────
zIndex:
  sticky: 100
  overlay: 300
  modal: 400
  toast: 500

# ── Layout ─────────────────────────────────────────────────────────────
# Content follows its container — an operational workspace fills the space it is
# given (tables, trees, run detail), so there is NO global max-width / reading
# measure. Only the fixed structural metrics live here.
layout:
  rail-width: 56px # collapsed left rail
  field-height: 36px # canonical control height (inputs, selects) — see components.input
  control-height: 34px # canonical button height — see components.button-*
  # Shared floating-surface width contract. Menu, Popover, and Select keep
  # separate interaction semantics but consume the same compact → picker scale.
  overlay-surface-compact-min-width: 140px
  overlay-surface-compact-max-width: 200px
  overlay-surface-content-min-width: 160px
  overlay-surface-content-max-width: 260px
  overlay-surface-regular-min-width: 232px
  overlay-surface-regular-max-width: 280px
  overlay-surface-wide-min-width: 280px
  overlay-surface-wide-max-width: 320px
  overlay-surface-picker-min-width: 320px
  overlay-surface-picker-max-width: 360px

# ── State ──────────────────────────────────────────────────────────────
# One vocabulary for interaction feel, so every hover/disabled/selected reads
# the same across views. Express as opacity or a neutral overlay over the base,
# never as a hand-picked second color.
state:
  hover-overlay: { light: "oklch(from {colors.text} l c h / 0.045)", dark: "oklch(from {colors.text} l c h / 0.06)" } # subtle wash on hover
  active-overlay: { light: "oklch(from {colors.text} l c h / 0.065)", dark: "oklch(from {colors.text} l c h / 0.09)" } # pressed/selected row
  disabled-opacity: 0.45 # disabled controls — dim, never recolor
  muted-opacity: 0.65 # de-emphasized but still active
  selected-tint: "{colors.accent-soft}" # selected item background

# ── Focus ──────────────────────────────────────────────────────────────
# Focus is one language everywhere: same width, same offset, same color.
# Always visible — never remove the ring, only restyle it.
focus:
  ring-width: 3px
  ring-color: "{colors.focus-ring}"
  ring: "0 0 0 3px {colors.focus-ring}" # the composed value components apply

# ── Components ─────────────────────────────────────────────────────────
# Documented from the real implementation (components/ui + dialog.css). Values
# reference tokens above. These are the only component specs in this contract;
# everything else is component-scoped in tokens.css.
components:
  button-primary:
    minHeight: "{layout.control-height}"
    paddingX: "{spacing.3}"
    radius: "{rounded.md}"
    fontSize: "{typography.fontSize.base}"
    fontWeight: "{typography.fontWeight.semibold}"
    backgroundColor: "{colors.accent-solid}" # filled interaction color; never invert from the text scale
    hoverBackgroundColor: "color-mix(in srgb, {colors.accent-solid} 88%, {colors.overlay-ink})"
    textColor: "{colors.white}"
    transition: "{motion.duration.fast} {motion.easing.standard}"
  button-ghost:
    minHeight: "{layout.control-height}"
    paddingX: "{spacing.3}"
    radius: "{rounded.md}"
    fontSize: "{typography.fontSize.base}"
    fontWeight: "{typography.fontWeight.semibold}"
    backgroundColor: "transparent" # --dialog-ghost-bg when surfaced
    textColor: "{colors.text}"
  input:
    height: "{layout.field-height}"
    paddingX: "{spacing.3}"
    radius: "{rounded.md}"
    fontSize: "{typography.fontSize.md}"
    border: "1px solid {colors.border}"
    backgroundColor: "{colors.surface}"
    focusRing: "{focus.ring}"
---

# OpenGrove Design System

OpenGrove should feel like a quiet professional workspace for long agent work:
grounded in local runtime and data, precise, readable, and calm. It is an operational app, not a
marketing site or a neon agent dashboard.

This document is the design **contract**. The frontmatter above is the
canonical source for semantic tokens, global scales, and compatibility aliases;
[`tokens.css`](./tokens.css) is the CSS implementation. Its generated global
block is synchronized from this file by `npm run tokens:gen`; `npm run
tokens:check` treats mismatches as implementation drift. Apply the tokens —
never set a raw color, font size, radius, or duration by hand when a token
exists. New shades are added to the scale, not minted inline. The
`scripts/audit-css.mjs --check` enforces this on component CSS with a per-file
historical-debt ratchet, and `npm run tokens:lint` blocks component-token
literals inside `tokens.css`. The audit does not cap CSS file count: a new
co-located module is welcome when it consumes this contract without inventing
local design values.

This contract may evolve. If the product needs a genuinely reusable color role,
spacing step, radius, motion, elevation, or primitive that is missing here, add
it here first and regenerate the implementation. “Use the design system” means
centralize intentional design decisions, not freeze the existing list forever.

## Overview

A low-saturation light UI by default: gray outer shell, white active workspace,
quiet fills, restrained shadows. Hierarchy comes from tonal surfaces and fills
(see Layering), not from a grid of hairlines, not from heavy shadow or color
wash. The dark theme is a premium workspace, not a terminal skin — it mirrors
every semantic role with a single set of overrides.

The character words — *quiet, precise, readable, calm* — are not decoration;
each is a constraint the tokens enforce:

- **Calm** → motion is off by default and only marks a state change; shadows are
  layered but faint; at most one accent color visible per view.
- **Precise** → every value comes from a token; spacing lands on the spacing
  scale — 4px grid at and above `{spacing.4}`, 2px half steps below it; one
  radius family per surface.
- **Readable** → dense by default but never cramped; content follows its
  container (an operational tool fills the space it is given).
- **Quiet** → color is a budget (see Colors); the neutral surface does the
  structural work so accents stay scarce.

## Layering

Four tools separate things on screen. Each owns exactly one job, and using one
for another's job is how this UI goes wrong: a hairline grid where a tonal step
belongs reads as a wireframe, and a shadow where a tonal step belongs reads as
a popup that never closes.

| What is being separated | Tool |
| --- | --- |
| Structure — canvas, panel, recessed block | opaque tonal step (`{colors.bg}` / `{colors.surface}` / `{colors.surface-sunken}`) |
| Two panels sitting side by side | the canvas seam between them — no border, no second tone |
| A container or control nested *inside* a surface | translucent fill (`{colors.fill}`, hover `{colors.fill-strong}`) |
| Repeating siblings — list rows, table rows, message groups | hairline (`{colors.line-04}`…`{colors.line-12}`) |
| Something genuinely floating — menu, popover, dialog | elevation (`{elevation.md}` / `{elevation.lg}`) |
| State and meaning — selected, focused, error, live | color, which never carries structure |

**The sheet is the brightest step — in both themes.** Light: `{colors.surface}`
(white) sits on a darker canvas; dark: `{colors.surface}` sits on a darker
canvas too. The relationship is identical, so one rule describes both themes:
paper is lighter than the board it lies on, and a recessed panel is darker than
the board. A theme never inverts the order of the ladder, only its values.

**The app frame is one continuous surface; every panel on it is the same paper.**
The window background and the app rail are the frame — the rail paints nothing of
its own, so product navigation reads as part of the shell rather than as a panel.
Everything the frame carries is one sheet: conversation sidebar, contacts
sidebar, settings shell, main panel. A sidebar is not a recessed plane, and what
separates two panels is the ~10px of frame between them. That seam is a real
separator (Δ0.030 L in light — thin enough that the seam's width and radius are part
of the language, not free layout values; in dark the frame is painted
`{colors.overlay-ink}` by `--app-rail-collapsed-bg`, so the measured seam is Δ0.28
and `{colors.bg}` never actually shows) — which is why panels carry neither
a border nor a second tone. The corollary is a constraint on layout: a panel that
loses its margin loses its boundary, so full-bleed adjacent panels need a
hairline instead of a seam. The intended structural job of
`{colors.surface-sunken}` is a block recessed *into* a panel (an App Store row,
a quoted message); legacy non-structural consumers are migration debt, not a
reason to retune the shared value.

**Opaque steps are budgeted; fills are not.** At most **three** opaque steps on
any single path from the window edge to a leaf. The ceiling is physical, not
stylistic: a light UI has roughly `{colors.surface}` (100%) down to ~92% L of
usable range before it stops reading as light, so a fourth structural step would
land inside the just-noticeable difference of a third. Anything nested deeper
than three steps uses a fill, which is measured against whatever it sits on and
therefore always visible.

**One fill scale, two steps.** `{colors.fill}` at rest, `{colors.fill-strong}`
for hover/selected. Row hover and active are references to those two, not a
sidebar dialect — a third hand-mixed alpha is a bug, not a nuance.

**Never take a hairline off a container without giving it a fill.** A bordered
container is invisible the moment its border goes if its background equals its
parent's — the element does not look flatter, it disappears. This is what the
`{colors.fill}` family is for, and `npm run check:css` enforces the ladder that
makes it work (`scripts/check-surface-ladder.mjs`): every pair of surfaces the
contract allows to touch must differ by at least 0.015 L, fills composited over
their parents included.

**Hairlines that stay.** Between repeating siblings (a settings row above the
next settings row, table rows, a message group divider), and every functional
edge: focus ring, error state, drag-and-drop target, quote bar. These are
signals, not decoration — removing them removes information.

## Colors

Color encodes **intent, not decoration**. The default surface is neutral; color
is a budget, spent only where it carries meaning. Each accent has a fixed list
of places it is allowed to appear — a recipe, not a prohibition.

**Interaction blue — `{colors.interaction-blue}` (`#2f95f3`).** The one
interaction blue. Allowed exactly at: the selected item, the focus ring,
the primary action in a view, an in-progress/live marker, and an active toggle.
`{colors.accent}` resolves to it. If blue appears anywhere else, it is a bug.
White text on `{colors.accent}` is only 3.1:1, so a filled accent background
behind white label text (a primary button) must use `{colors.accent-solid}`
instead — the same hue deepened to ≥4.5:1 — with hover/active derived from it
via `color-mix`, never a hand-picked third blue.

**Brand green — `{colors.brand-green}` (`#168a53`).** Identity and *earned*
success. Allowed exactly at: the logo, a connected/online indicator, a
saved/accepted/done confirmation, and a true success toast. Green is never a
background, never a hover, never decoration.

**State colors — rare by design.** `{colors.success}`, `{colors.warning}`,
`{colors.error}` appear only at the moment a warning, failure, or completed
success is meaningful — typically one per view at most. Until then, use a
neutral tag. A screen with no state color is the healthy default, not an
unfinished one.

**Neutrals carry the structure.** Every grey is a `{colors.neutral-100..900}`
step; every divider is a `{colors.line-04..12}` alpha; every surface is a
`{colors.surface}`/`{colors.surface-sunken}` step. Hierarchy is built from these
tonal moves, so the accents stay scarce and therefore legible. Component tokens
now express their fills, borders, gradients, and shadows through these roles
instead of carrying their own raw hex/rgb values.

> **Known deviation (do not "fix" silently):** `{colors.link}` (`#2563eb`) is a
> second blue still used by links and by the Rooms/Contacts surfaces
> (`--rooms-blue`, `--contacts-rooms-blue`). The canonical interaction blue is
> `#2f95f3`. Treat `#2563eb` as link/collaboration-state blue unless a later
> product decision converges it; do not introduce a third blue.

## Color model

The frontmatter colors above are the implementation, not a sketch. Core palette
values use OKLCH, neutral ramps and interaction overlays are derived with
`color-mix`/relative color syntax, and component-token internals are linted so
new one-off hex/rgb values cannot re-enter `tokens.css`.

Three shifts keep the system stable: **a theme is a few endpoint colors, and
everything else is derived from them** — so changing a theme can't leave stray,
out-of-sync values behind.

1. **OKLCH for the palette.** Define core colors as `oklch(L C H)` — lightness,
   chroma, hue — instead of hex. Dark mode keeps the **same hue**, shifting only
   L (and nudging C). A color can't drift to a different hue between themes, and
   "muted in light, more saturated in dark" becomes a deliberate, legible move
   (light accent stays low-chroma; dark raises it so it reads on a dark surface).

2. **Derived neutrals via `color-mix`.** `{colors.neutral-100..900}` are mixes
   of two endpoints:
   `color-mix(in srgb, {colors.text} N%, {colors.bg})`. One foreground/background
   pair regenerates the whole grey ramp; change either endpoint and every
   divider, hover wash, muted-text and disabled state updates in lock-step. These
   greys are the bulk of the UI (borders, fills, secondary text), so unifying
   their source is what makes the surface feel consistent.

3. **Derived interaction states.** The focus ring is the theme's own foreground
   at low alpha — `oklch(from {colors.text} l c h / 0.25)` — so it auto-follows
   any theme rather than being a pinned blue. Hover/active overlays (see `state`)
   follow the same "tint of foreground over base" rule.

`{colors.popover}` / `{colors.popover-solid}` exist for the same forward reason:
`popover-solid` is guaranteed opaque so a future scenic/glass mode (translucent
panels over a background image) still has a readable layer behind text. Adding
the token now is free; retrofitting it after glass ships is not.

The hand-authored component layer can still contain component-shaped values
(gradients, multi-layer shadows, asymmetric art geometry), but the color atoms
inside those values must be semantic references or derived expressions. Current
gate: `npm run tokens:lint` reports zero component-token hex, numeric rgb/rgba,
off-scale font-size tokens, and off-scale UI radius tokens.

## Typography

Use one UI font stack: `{typography.fontFamily.sans}` for UI and prose, and
one mono stack: `{typography.fontFamily.mono}` for code, logs, IDs, and raw
file previews. Controls inherit the page font; do not set per-component font
families except to switch to mono content.

The visible type scale is collapsed to six actual sizes. Legacy token names
remain for source compatibility, but they must not introduce new visual steps.
Apply the size tokens instead of writing `font-size` by hand. Keep
`letter-spacing` at `0`.

| Role | Token | Size |
| --- | --- | --- |
| Page / workspace title | `{typography.fontSize.2xl}` or `{typography.fontSize.3xl}` | 24px / 600 |
| Panel / dialog title | `{typography.fontSize.xl}` | 20px / 600 |
| Section title | `{typography.fontSize.lg}` | 16px / 600 |
| Default body | `{typography.fontSize.md}` or `{typography.fontSize.base}` | 14px |
| Dense UI / code | `{typography.fontSize.sm}` | 12px |
| Meta / timestamps / micro badges | `{typography.fontSize.xs}` or `{typography.fontSize.2xs}` | 11px |

The ramp is intentionally plain — an operational tool earns its polish from
surface, shadow, and motion, not from an elaborate type scale. Body stays at
`{typography.lineHeight.normal}` (1.45); long-form markdown and chat prose can
use `{typography.lineHeight.relaxed}` (1.6). Tight labels and titles use
`{typography.lineHeight.tight}` (1.25). Do not invent intermediate line heights
inside component CSS.

Use three visible weights only:

| Role | Token | Weight |
| --- | --- | --- |
| Regular UI text | `{typography.fontWeight.normal}` | 400 |
| Emphasized labels / active nav | `{typography.fontWeight.medium}` | 500 |
| Section titles / primary labels | `{typography.fontWeight.semibold}` or `{typography.fontWeight.bold}` | 600 |

All component `font-size` tokens are on this scale. `npm run tokens:lint` fails
if a new component token introduces a raw px or `em` size instead of `--fs-*`.

## Layout

The app shell has three product areas:

| Area | Role |
| --- | --- |
| Left rail | Global navigation and app identity |
| Context sidebar | Project, thread, room, folder, or object navigation |
| Main workspace | The active conversation, document, app, room, or preview |

Spacing follows the spacing scale (`{spacing.0-5}`–`{spacing.10}`): the 4px grid
at and above `{spacing.4}`, 2px half steps below it. The shell and its content
are fluid — an operational workspace fills the space it is given (tables, trees,
run detail), so there is no global max-width. Rules:

- Do not bury main objects inside nested cards.
- Use rows for dense operational settings; cards only for repeated items,
  modals, dialogs, and genuinely framed tools.
- Sidebar popovers must render above clipped scroll containers.
- Floating surfaces use one width vocabulary: `compact` (140–200px), `content`
  (160–260px), `regular` (232–280px), `wide` (280–320px), and `picker`
  (320–360px). Menu, Popover, and Select consume
  those bounds without sharing interaction primitives: actions remain
  `menu/menuitem`, selection remains `listbox/option`, and a generic Popover
  keeps the role supplied by its caller. `preserve` is the explicit escape
  hatch for an existing caller-owned width.
- Every view needs loading, empty, unavailable, error, and active states.
- Component `padding`/`margin`/`gap`/`inset` values consume `{spacing.*}`
  tokens. Zero and an exact `1px` hairline are the only literal exceptions;
  changing the unit does not create an exception. Percentage, viewport,
  container-query, and font-relative lengths are also audited. If a repeated
  responsive layout need does not fit the scale, add one named shared rule here
  instead of repeating a local number.
  `scripts/audit-css.mjs --check` records existing literals by owner file and
  rejects new ones.
- There are no half steps above `{spacing.4}`: never add a step between the 4px
  multiples there — a 2px difference at that size reads as noise, and a denser
  scale only makes the choice harder. Below `{spacing.4}` the 2px half steps
  above are the full set. Odd values (3px, 5px, 7px, 9px…) never become tokens;
  snap them to the nearest step. A one-off optical inset or a fixed component
  dimension is not spacing — give it its own named component token rather than a
  spacing step.
- `npm run spacing:codemod` reports exact, semantics-preserving replacements
  from positive `px` values to existing `--sp-*` tokens. It is dry-run by
  default; apply requires an explicit path, for example
  `npm run spacing:codemod -- --apply web/src/components/example.module.css`.
  The codemod deliberately skips negative values, non-`px` units, functions,
  mixed keyword values, and lengths without an exact token. It must not snap a
  value to the nearest grid step or invent a token.

## Elevation & Depth

Shadows are **layered, not single-cast**. Every level pairs a 1px border ring
(the foreground color at `{elevation.border-opacity}` — this keeps the edge
crisp) with cascading black blur layers that fade as they spread, so a surface
reads as *floating above* the canvas rather than *printed on* it. Two knobs,
`{elevation.border-opacity}` and `{elevation.blur-opacity}`, scale the whole
system and rise in dark mode so shadows stay visible on dark surfaces.

- `{elevation.flat}` — the ring alone, for quiet separation (resting cards, wells).
- `{elevation.sm}` — raised rows, resting controls.
- `{elevation.md}` — popovers, dropdowns, menus.
- `{elevation.lg}` — dialogs and modals.

Consumption is fixed, not per-component: every menu/popover/context-menu shadow
is `var(--shadow-md)`, every dialog/modal/lightbox/overlay-panel shadow is
`var(--shadow-lg)`. Component-scoped tokens (e.g. `--composer-menu-shadow`,
`--app-store-dialog-shadow`) keep their names but must reference the elevation
token as their value — never hand-write blur offsets or shadow alphas. Dark
theme uses the same references; the elevation scale itself rises in dark mode,
so no dark-only shadow overrides.

Still prefer a tonal surface step (`{colors.surface}` → `{colors.surface-sunken}`)
or a fill (`{colors.fill}`) before reaching for elevation at all — depth is
earned, not default, and elevation means *floating*, not merely *distinct* (see
Layering).

## Motion

**Motion is off by default.** Animate only where movement *explains* a change —
a state toggling, an item being created or removed, a panel revealing its
contents. Decorative or ambient motion is not used; overlays and dropdowns may
appear instantly rather than fade, because an operational tool should feel
*instant*, not animated.

When motion does clarify something:

- **Color / state changes** → `{motion.duration.instant}`–`{motion.duration.fast}`,
  `{motion.easing.standard}`. Hover and selection feedback should feel immediate.
- **Reveals** (a popover opening, content appearing) → `{motion.duration.normal}`–`{motion.duration.slow}`
  with `{motion.easing.entrance}` — the soft-landing curve, so things settle in
  rather than snap.
- **Loading spinners** → one shared `@keyframes spin` (defined once in
  `reset.css`) at `{motion.duration.spin}` (800ms). Do not define per-component
  spin keyframes; the 800ms loop is exempt from the ≤260ms rule because it is a
  repeating indicator, not a state transition.
- Keep every transition duration ≤ `{motion.duration.slow}`. Honor `prefers-reduced-motion`
  — when set, drop to instant.

## Shapes

Tight radii. `{rounded.md}` (10px) is the default control radius; `{rounded.lg}`
(12px) for cards and paper; `{rounded.pill}` for avatars, status dots, and
toggles; `{rounded.none}` for full-bleed surfaces (knowledge, workspace,
preview). Keep one radius family per view.

## Components

These specs are documented from the real implementation. They reference the
tokens above; the values themselves live in `components/ui` + `dialog.css`.

- **Primary button** — solid ink (`{colors.text}`, inverts in dark), 34px tall,
  `{rounded.md}`, `{typography.fontSize.base}` / `{typography.fontWeight.semibold}`,
  `{motion.duration.fast}` hover.
- **Ghost button** — transparent until surfaced, same metrics as primary,
  `{colors.text}` label.
- **Input** — 36px tall, `1px solid {colors.border}`, `{rounded.md}`,
  `{typography.fontSize.md}`, focus ring `0 0 0 3px {colors.focus-ring}`.
- **Controls** — lucide icons for common controls; icon-only controls need
  accessible labels and tooltips. Toggles for enabled/disabled, segmented
  controls for modes, inline selects for compact choices, list rows for
  settings. Buttons express commands, not passive state.
- **Interaction states are one vocabulary.** Hover applies
  `{state.hover-overlay}`, pressed/selected `{state.active-overlay}`, disabled
  drops to `{state.disabled-opacity}` (dim, never recolor), and focus is always
  `{focus.ring}`. Do not invent per-component hover colors — apply the overlay
  over the base so every surface feels the same under the cursor.

## Tailwind and existing CSS

Tailwind is an opt-in implementation tool, not a second design system. The
generated tokens in this document remain the source of truth, and the existing
reset remains canonical: `styles.css` imports Tailwind's theme and utilities,
but deliberately omits Preflight.

- Use Tailwind for new React component-local layout, spacing, typography,
  responsive behavior, and interaction states. Prefer semantic utilities such
  as `bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`,
  `border-border`, and `ring-ring`.
- Do not use Tailwind's named color palette or arbitrary color, radius, shadow,
  or motion values when an OpenGrove token already exists. A missing shared
  value belongs in this contract first.
- Keep CSS Modules or the existing component stylesheet for keyframes, complex
  pseudo-elements, third-party overrides, and selectors that coordinate several
  descendants. Shared shell and primitive rules remain CSS.
- Do not mass-migrate old CSS. Unrelated legacy styles stay as they are. When a
  component is substantially rebuilt, migrate only that component and remove
  the declarations now owned by its utilities in the same change.
- Do not let Tailwind classes and a stylesheet compete for the same property on
  the same element. Existing unlayered CSS intentionally wins over Tailwind's
  utility layer, so a touched legacy component must remove conflicting rules
  before relying on utilities.
- Review and test each migration as a behavior-preserving vertical slice. A
  migration is not complete until light/dark themes, responsive states, focus,
  disabled state, and the existing CSS audit all pass.

## Chat & Rooms

- Chat foregrounds the current turn and context.
- The composer is the primary input device: clean white surface, fine hairline,
  quiet controls, familiar icons for attach, mic, model, access, and send.
- Rooms must never be blank — show useful states for no rooms, no members,
  remote unavailable, empty room, active conversation, and errors.
- Contacts are explicit entities. Do not auto-create employees from newly
  detected kernels.

## Knowledge & Apps

- Knowledge feels like a local file workspace: tree, document, properties, and
  markdown/code readability.
- Mounted Apps open directly as web or file workbench surfaces, with App-bound
  chat available where the App declares a workspace.

## Voice & Content

- Keep UI copy direct and operational; no marketing explanations inside the app.
- Chinese copy is concise and natural, not slogan-like.
- Error text names the blocked action and the next recovery step.

## Do's and Don'ts

- **Do** apply tokens; **don't** hand-set color, size, radius, or duration when
  a token exists.
- **Do** add genuinely missing shared colors, spacing, radii, motion, elevation,
  or primitives to this contract; **don't** mint inline literals in product
  components (the audit gate will reject them).
- **Do** keep status colors rare and meaningful; **don't** wash the UI in green
  or add gradients/glows.
- **Do** separate a nested container with a fill (`{colors.fill}`) and repeating
  siblings with a hairline; **don't** outline every static container, and never
  drop a container's border while leaving its background equal to its parent's —
  that deletes the container instead of quieting it (see Layering).
- **Do** give every view its full set of states; **don't** ship a blank Room or
  empty surface.
- **Do** keep visible focus rings (`{colors.focus-ring}`) and rely on more than
  color alone to convey state.
