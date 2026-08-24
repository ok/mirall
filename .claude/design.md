# Mirall Design System

The authoritative, implementation-true reference for the renderer's visual
language: colors, typography, spacing, radii, elevation, components, motion,
and platform chrome. This documents **what ships today**, not aspirations —
every claim is traceable to a source file. Keep it in sync when you change the
UI; treat divergence between this doc and the code as a bug in whichever is wrong.

The renderer is React 19 + Tailwind v4, bundled by esbuild
(`src/renderer/` → `assets/dist/`). The system is a Material Design 3 token
model: CSS custom properties define the palette, Tailwind maps them to
`var()`-backed utility colors, and a `.dark` class on `<html>` swaps the theme.

**Source of truth — read these before changing tokens:**

| Concern | File |
|---|---|
| Color tokens (light + dark), fonts, base CSS | `src/renderer/styles/tailwind.css` |
| Token → Tailwind mapping, font families, radius scale | `tailwind.config.js` |
| Theme switch (light/dark/system), `color-scheme` | `src/renderer/theme.ts`, `assets/theme-bootstrap.js` |
| Theme persistence (`appearance.theme`) | `src/renderer/config-client.ts` (`config.json`) |
| Fonts (self-hosted woff2) | `assets/fonts/manrope.woff2`, `assets/fonts/plusjakarta.woff2` |
| Primitives | `src/renderer/components/primitives/` |
| Cards, layout, modals, toasts, widgets | `src/renderer/components/{cards,layout,modals,toast,widgets}/` |

---

## 1. Principles (as actually applied)

- **Tokens, never raw hex in components.** Use the semantic Tailwind colors
  (`bg-surface-container-low`, `text-on-surface-variant`, …). Raw `bg-[#…]`
  appears in exactly one curated place — the per-space icon palette
  (`gradientForSpaceId`, `src/renderer/utils.ts`).
- **Depth through surface tiers, not lines.** Sectioning is done by stepping
  the `surface-container-*` ramp, not by 1px borders. Borders are the rare
  exception (see §10), used deliberately, not for layout containment.
- **Soft, heavy rounding.** The UI reads as stacked rounded cards; corner radii
  climb with element size (§5).
- **App, not webpage.** Text is not user-selectable; copy is offered through an
  explicit `<CopyButton>` (`src/renderer/components/primitives/CopyButton.tsx`).
- **Accessibility is a gate, not a finish.** Every interactive control carries a
  name/role/state; focus is always visible; motion respects the OS setting.
  See `.claude/testing.md`.
- **Desktop-first, fixed-width.** Almost no responsive breakpoints — this is a
  windowed Electron app, not a fluid web page (§4).

---

## 2. Color

Defined in `src/renderer/styles/tailwind.css` (`:root` = light, `.dark` = dark),
exposed as Tailwind utilities in `tailwind.config.js`. Full MD3 ramps exist for
each key color (`-container`, `-fixed`, `-fixed-dim`, `-fixed-variant`,
`on-*`). The most-used values:

### Brand & surfaces — light

| Token | Hex | Role |
|---|---|---|
| `primary` / `accent` | `#33253b` | Twilight plum. Headings, primary buttons, key text. (`accent` == `primary` in light mode.) |
| `on-primary` | `#ffffff` | Text/icon on primary |
| `secondary` | `#904d00` | Burnt amber — focus rings, links, secondary emphasis |
| `secondary-container` | `#fd9c42` | Signature orange (the "Mirall dot", progress fill) |
| `on-secondary-container` | `#6b3800` | |
| `tertiary` | `#541116` | Deep rose — sparing high-emotion accents |
| `surface` | `#fbf9f5` | App background (warm cream) |
| `surface-container-lowest` | `#ffffff` | **File cards at rest (light)**; space cards; folder cards at rest (dark) — see folder/file note |
| `surface-container-low` | `#f5f3ef` | Section/setting cards; **folder cards at rest (light)**; file cards at rest (dark) |
| `surface-container` | `#efeeea` | |
| `surface-container-high` | `#eae8e4` | Neutral chips, toggle track, progress track, icon tiles |
| `surface-container-highest` | `#e4e2de` | **Card hover lift** (folder & file rows); avatar fallback, "remote" badge |
| `on-surface` | `#1b1c1a` | Primary body text (near-black; **never** `#000`) |
| `on-surface-variant` | `#4a454b` | Muted/secondary text |
| `outline` | `#7c757c` | Badge border, dropzone idle border |
| `outline-variant` | `#ccc4cc` | |
| `background` | `#fbf9f5` | **Kept in sync with `BG_LIGHT` in `src/main/main.js`** so the native window edge doesn't flash a different color on resize |

### Semantic / status — light

| Token | Hex | Used for |
|---|---|---|
| `success` / `on-success` | `#c1ecc4` / `#0c4d20` | The green "it's on your device" state — shared-by-you + downloaded |
| `info` / `on-info` | `#d6e6f5` / `#1f4a78` | The blue "in transfer" state — downloading / preparing / adding |
| `online` / `offline` | `#0d8b80` / `#a0a4ac` | Member presence |
| `warning` / `on-warning` | `#fcd34d` / `#1b1c1a` | The yellow "needs attention" state — paused / folder missing on disk |
| `error` | `#ba1a1a` | Hard error text/icon |
| `error-container` / `on-error-container` | `#ffdad6` / `#93000a` | Danger button rest, error toast/badge |
| `error-container-hover` | `#f5c8c4` | Danger button hover |
| `icon-tile` / `on-icon-tile` | `#fec78a` / `#0a4742` | Reserved icon-tile pair (defined; most tiles render on `surface-container-high`) |

### Dark theme

Dark mode is a complete second palette (`.dark` block) and **inverts the brand
relationship**: `primary` becomes the orange `#fd9c42` and `accent` becomes warm
cream `#fce8d2`, sitting on a cool slate surface ramp. The dark surface tiers
(authoritative in `tailwind.css` — easy to get subtly wrong when hand-building a
mockup): `surface` `#282c34`, `surface-container-lowest` `#21252b`,
`surface-container-low` `#2e3239`, `surface-container` `#2e323a`,
`surface-container-high` `#5c6068`, `surface-container-highest` `#393f4a`. **The
ramp is not monotonic by name in dark** — `surface-container-high` (`#5c6068`) is
markedly *lighter* than `-highest` (`#393f4a`); this is why secondary buttons use
`dark:bg-surface-container-highest` deliberately (and `dark:hover:bg-surface-container-high`,
a step *lighter* on hover). The `icon-tile` pair (`#fec78a` / `#0a4742`) is **not
inverted** — it keeps its warm-peach light values in dark. Every status token has a dark variant.
`--color-background` syncs with `BG_DARK` in `main.js`.

**Folder vs file card surfaces (two-tier — the folder is the darker card in both themes).**
Folder cards — folder shares (`ShareCard`) and folder-tree rows (`FolderTree`) — rest on
`surface-container-low` in light (`#f5f3ef`) and `surface-container-lowest` in dark (`#21252b`).
File cards — `FileCard`, `ShareFileRow` — rest on `surface-container-lowest` in light (`#ffffff`)
and `surface-container-low` in dark (`#2e3239`). So the folder is always the darker surface and
the file the lighter one, in both themes (in dark: folder darker than the background, file
lighter). Both lift to `surface-container-highest` on hover — a single, clearly-visible step
that never collides with the `surface-container-high` icon tile. Spaces (`SpaceCard`) stay on
`surface-container-lowest` (the prominent card on the spaces home, not part of the folder/file
pair). The folder-tree disclosure chevron uses `text-on-surface-variant` (not `outline`, which
fails the contrast floor on these surfaces in dark).

Theme is chosen via `theme.ts` (`light` | `dark` | `system`); `theme.ts` only
**applies** the theme — toggling the `.dark` class and setting
`document.documentElement.style.colorScheme` so native UI (scrollbars, form
controls) matches. Persistence lives in `config.json` (`appearance.theme`) via
`src/renderer/config-client.ts`; the legacy `mirall:theme` localStorage key is
read once for migration then deleted. `assets/theme-bootstrap.js` applies the
stored theme before React mounts to avoid a flash.

### Adding a new semantic token (two edits, not one)

A new color takes **two** file edits — miss the second and it fails *silently*.

1. Define `--color-{name}` (and its `--color-on-{name}` pair) in **both** the
   `:root` and `.dark` blocks of `src/renderer/styles/tailwind.css`.
2. Register `'{name}': 'var(--color-{name})'` (plus the `on-` variant) under the
   `theme.extend.colors` block in `tailwind.config.js` — the same block where
   `success`, `info`, `error-container`, `warning`, etc. already live.

Skip step 2 and Tailwind never emits the `bg-{name}` / `text-on-{name}` utility
classes: the JSX class becomes a no-op, the surface renders unstyled, and there's
no dark-mode rule for the `.dark` cascade to flow through. **The failure is
silent at build time** — TypeScript and esbuild are happy; only the pixels are
wrong. Verify after `npm run build:css` with
`grep "bg-{name}" assets/dist/app.css` (the compiled, minified output).

---

## 3. Typography

Two self-hosted fonts (`@font-face` in `src/renderer/styles/tailwind.css`),
mapped in `tailwind.config.js`:

- **Plus Jakarta Sans** — `font-headline` / `.font-headline`. Only weights
  **700–800** are loaded. All headings, button labels, section/segment labels.
- **Manrope** — `font-body` / `font-label`, and the default on `<body>`.
  Weights **400–600**. All body and UI text.

There is **no named type scale** (no `display-lg`, `body-lg`, etc.). Headings use
plain Tailwind sizes + `font-headline`:

| Use | Classes | Where |
|---|---|---|
| Page title | `text-4xl font-headline font-extrabold text-accent tracking-tight` (`md:text-5xl` on onboarding) | `components/layout/PageHeader.tsx` |
| Modal title | `text-2xl font-headline font-extrabold text-accent tracking-tight` | modals, `keyboard/*` |
| Section heading | `text-xl font-headline font-bold text-accent mb-6` | `components/layout/SectionHeading.tsx` |
| Eyebrow / group label | `text-xs font-bold uppercase tracking-wide text-secondary` | `keyboard/ShortcutsHint.tsx`, `screens/ActivityLog.tsx` day headings, what's-new |
| Body | default Manrope, muted via `text-on-surface-variant`; `leading-relaxed` on intros | everywhere |
| Metadata / fine print | `text-xs` / `text-sm text-on-surface-variant` | cards, badges |

---

## 4. Spacing & layout

- **Page shell.** Screens are a fixed-height scroll container with a centered
  inner column:
  `h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8`,
  inner `pt-8 px-8 max-w-2xl mx-auto` (settings/account) or
  `max-w-7xl mx-auto px-8` (spaces list, space, folder views).
- **`--banner-h`** is a live CSS variable published by `UpdateBanner` via a
  ResizeObserver (`components/layout/UpdateBanner.tsx`); every screen subtracts
  it so content shifts when the update banner appears/disappears.
- **`px-8` (2rem / 32px) is the universal page gutter** — matched by the
  `TopNav` and `UpdateBanner` bars so their content aligns with the screens,
  and equal to the `pt-8` top / `pb-8` bottom breathing room (consistent 32px
  on all four sides).
- **Dominant spacing increments:** `gap-4` and `gap-6` (flex/grid),
  `space-y-6`, `space-y-10` (between settings sections), `p-5` (card rows),
  `p-6` (toggles, section cards), `p-8` (large cards).
- **Section pattern:** `<SectionHeading>` followed by a
  `bg-surface-container-low rounded-xl p-6` card. All settings sub-pages share
  this shell.
- **Row-group pattern:** several short groups on one screen render as
  `<SectionHeading>` (the same label every settings sub-page uses) above a
  `bg-surface-container-low rounded-xl overflow-hidden` card of `p-6` rows —
  40px icon tile, `font-semibold text-accent` label, `text-xs` description,
  trailing chevron, no dividers. Used by `screens/Settings.tsx` (one unlabelled
  group) and `screens/Account.tsx`. A group the page title already names takes
  no heading — Account's profile card sits directly under the `<h1>`. The eyebrow
  label is **not** used for this job: it is for sub-labels inside a surface
  (shortcut groups, activity-log day headings).
- **Sticky in-page headers:** `sticky top-0 z-10 bg-surface` for list titles.
- **Responsive:** effectively one breakpoint — `min-[900px]:grid-cols-[1fr_300px] gap-8`
  (content + sidebar in `screens/SpaceView.tsx`, `screens/FolderView.tsx`), plus a
  couple of `md:` tweaks on onboarding. No `sm`/`lg`/`xl` grid system.

---

## 5. Border radius

Scale in `tailwind.config.js`: `DEFAULT 0.25rem`, `lg 0.5rem`, `xl 0.75rem`,
`2xl 1.5rem`, `3xl 2rem`, `full 9999px`. **There is no `md` token.**

In practice the system uses a "softness ladder" — radius grows with element
size, always via the named scale tokens above (no arbitrary `rounded-[…]`
values). The two large-container tiers are kept deliberately uniform: every big
card uses `rounded-2xl` (1.5rem), and modal panels sit one step above at
`rounded-3xl` (2rem).

| Radius | Applied to |
|---|---|
| `rounded-xl` (0.75rem) | Buttons, inputs, file/share cards, section cards, command-palette rows |
| `rounded-2xl` (1.5rem) | SpaceCard, DropZone, CollapsibleCard, Onboarding card, FolderView sidebar info cards (owner + folder-size), CreateSpace preview card |
| `rounded-3xl` (2rem) | Modal panels (Modal default + per-modal overrides, command palette, shortcuts) |
| `rounded-full` | Avatars, badges, pills, toggle, segmented control, icon buttons |

---

## 6. Elevation, shadows & surface effects

- **Ambient, purple-tinted shadow** for floating chrome:
  `shadow-[0_12px_40px_rgba(74,59,82,0.06)]` (TopNav, Onboarding header);
  `0.04` variant on the Onboarding card. This is the system's signature soft lift.
- **Primary buttons** carry `shadow-lg shadow-primary/10`.
- **Modals** use `shadow-2xl shadow-black/30` (the one place a black-tinted
  shadow is used).
- **Glass / blur is narrow and deliberate:**
  - **TopNav & Onboarding header** are the only true glass surfaces:
    `bg-surface-container-lowest/70 backdrop-blur-xl` (the floating
    "atmospheric header").
  - **Modal backdrop** (`components/widgets/CrystalBackdrop.tsx`):
    `bg-primary/10 backdrop-blur-sm` in light; `dark:bg-surface/60` plus an
    animated crystalline SVG pattern in dark mode.
  - **Modal panels are opaque.** The `.glass-modal` class is *not* glass — it is
    `background: var(--color-surface-container-lowest)`. The blur belongs to the
    backdrop, never the panel. (The name is legacy; a comment in
    `tailwind.css` flags this.)
- **No CSS gradients ship.** `gradientForSpaceId` (`src/renderer/utils.ts`)
  returns a single flat `bg-[#hex] dark:bg-[#hex]` from a curated 7-color
  palette hashed by space ID — the "gradient" name is historical.

---

## 7. Components

Most components live under `src/renderer/components/` (`keyboard/` is a sibling).
Every interactive control uses the
universal focus ring `focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30`
(danger uses `ring-error/30`) and `active:scale-95` press feedback unless noted.

### Buttons — `primitives/Button.tsx`
Three variants only:
- **`primary`** — `bg-primary text-on-primary shadow-lg shadow-primary/10 hover:opacity-90`
- **`secondary`** — neutral surface (`bg-surface-container-high` →
  `hover:bg-surface-container-highest`; dark inverts one tier). Shared with the
  nav "Send feedback" button and used for Cancel/dismiss.
- **`danger`** — tonal `bg-error-container text-on-error-container` →
  `hover:bg-error-container-hover` (stays in the red family, never jumps to neutral).

Base: `rounded-xl font-headline font-bold transition-all active:scale-95 disabled:opacity-50`.
Sizes: `sm` (`px-5 py-2.5 text-sm`, default), `lg` (`h-14 px-5 text-lg`).
Optional leading icon at `size={20}`. `fullWidth` available.

### Icon button — `primitives/IconButton.tsx`
`w-10 h-10 rounded-full hover:bg-surface-container-high`. Requires `ariaLabel`;
icon defaults to `text-accent`.

### Toggle — `primitives/Toggle.tsx`
Full-width `role="switch"` row, `p-6`, label + optional description on the left,
a 48×28 pill track on the right (`bg-primary` on / `bg-surface-container-high`
off) with a 20px translating thumb. Hover lifts to
`bg-surface-container-high/50`.

### Dropdown button — `widgets/ActionMenu.tsx`
The one dropdown primitive; react-aria `useMenuTrigger` with a portalled popup that tracks the
trigger on scroll/resize. Three trigger variants, and a labelled trigger always carries a
trailing `keyboard_arrow_down` that rotates 180° when open:
- **`primary`** (default) — the labelled `bg-primary` key action ("More" in Space/Folder View).
- **`subtle`** — the icon-only `w-10 h-10 rounded-full` three-dot trigger (`ShareCard`).
- **`neutral`** — the labelled trigger wearing the **secondary-button** tokens
  (`bg-surface-container-high` → `hover:bg-surface-container-highest`, dark inverts one tier,
  `text-on-surface-variant`). For a row of sibling menus where none is the screen's main action —
  the Activity Log filter bar. Three `primary` triggers side by side would read as three CTAs.

Menu items may omit `icon`; a fixed-size blank keeps labels aligned, which is how a
single-choice menu marks only the selected row with `check`.

### Segmented control — inline pattern (no primitive)
Not a shared primitive — implemented inline in `screens/AppearanceSettings.tsx`
(theme + zoom selectors) and `components/modals/InviteModal.tsx` (expiry group).
A pill `bg-surface-container-high p-1 rounded-full` of `aria-pressed` buttons in
a plain flex `div` (no `role="group"`, no description line); the selected button
lifts to `bg-surface-container-lowest shadow-sm font-semibold`, others
`text-on-surface-variant`.

### Inputs
No dedicated primitive — inputs are styled inline and consistently:
`bg-surface-container-lowest` (or `-low`), `border-none rounded-xl px-4/5 py-4`,
focus via the universal ring (a **ring**, not a border). See `screens/Onboarding.tsx`,
`keyboard/CommandPalette.tsx`.

### Modal — `primitives/Modal.tsx`
react-aria `useDialog` + `<FocusScope contain restoreFocus autoFocus>`;
`role="dialog" aria-modal="true"`. Escape dismisses; Cmd/Ctrl+Enter fires
`onConfirm`; backdrop click dismisses (when `isDismissable`). A global
`CLOSE_MODALS_EVENT` closes any open modal.
- Panel default: `glass-modal w-full max-w-xl rounded-3xl shadow-2xl shadow-black/30 overflow-hidden`
  (override `max-w-*` per modal; `max-w-md` for compact/confirm, `max-w-2xl max-h-[80vh]` for What's New).
- Anatomy: header `px-10 pt-10 pb-6` (title + close `IconButton`); body
  `px-10 pb-10 space-y-{4–8}`; footer either a single full-width `lg` button or
  Cancel(`secondary`) + Action(`danger`), both `flex-1 h-14`.
- **Destructive intent is carried only by the `danger` button** — titles and
  body text stay in normal `text-accent` / `text-on-surface-variant`.
- Progress modals (Leave / Reclaim / Clear cache) animate through
  confirm → running (inline `ProgressBar`, `role="status" aria-live="polite"`,
  close hidden) → done.

### Toasts — `components/toast/`
Bottom-center stack: `fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2`,
`role="region"`. Max 4 visible, default 5s, **pause on hover/focus** with a
circular SVG progress ring on the close button. Each toast:
`rounded-lg px-4 py-3 shadow-lg`, icon + message + optional action, slide+fade
(`translate-y-2`). Variant **backgrounds** map to tokens — `error`→`error-container`,
`warning`→`warning`, `success`→`success`, `info`→`info` — but the **body text** is
always the regular foreground `on-surface-variant` (`#4a454b` light / `#ebe2d2` dark),
not a status tint; the status hue lives only on the **icon** (`iconColor`). Exception:
`warning` keeps dark `on-warning` text because its container stays bright yellow in
dark mode. A11y: error = `role="alert" aria-live="assertive"`, others = `status` / `polite`.

**Toast vs. banner — when to use which.** A **persistent, app-wide fault that blocks one
subsystem** (network down, download folder unreachable) is a **sticky toast**, not a banner:
`duration: 0`, a stable `id` so re-detection replaces rather than stacks, an `action` pointing at
the screen that fixes it, and a `success` toast on recovery. Drive it from a renderless *bridge*
component that watches the state and emits transitions —
`widgets/ConnectivityToastBridge.tsx` and `widgets/DownloadFolderToastBridge.tsx` are the two
worked examples; copy their shape rather than inventing a surface. Toasting only on a
**transition** is what lets a dismissed toast stay dismissed while the fault persists.

The **top-nav banner slot is reserved for `UpdateBanner`** — an informational notice that cannot
resolve itself (the update is staged until the app restarts) and so needs manual dismissal. It is
the only banner, and it owns `--banner-h`; adding a second one means reworking that variable's
ownership and every screen's scroll-height math, so reach for a toast first. Per-*screen*
affordances that are neither (a pending join request inside a space) are ordinary in-screen cards
— see `widgets/JoinRequestBanner.tsx`, which despite its name is a card, not a banner.

### Cards — `components/cards/`
All share `bg-surface-container-lowest hover:bg-surface-container-low dark:hover:bg-surface-container transition-colors`,
**no border, no shadow**:
- **SpaceCard** — `p-5 rounded-2xl`; flat-color icon tile
  (`gradientForSpaceId`) + overlapping avatar stack (`-space-x-3`).
- **ShareCard / FileCard** — `rounded-xl`, row layout, action buttons revealed on
  hover (`opacity-0 group-hover:opacity-100`). FileCard uses a container query
  (`@container/row`) to drop the status badge when narrow.
- **MemberCard** — `flex items-center justify-between`, no hover lift; presence
  shown via the avatar's status ring.
- Lists rely on spacing + surface tiers, **not dividers** — the one exception is
  `screens/StorageSettings.tsx` (`divide-y divide-surface-container-high/30`).

### Avatar — `primitives/Avatar.tsx`
Sizes `xs 20 / sm 32 / md 36 / lg 48 / xl 80` px, always `rounded-full`.
Image (`object-cover`), initials fallback on `surface-container-highest`, or a
silhouette SVG. Status ring via `box-shadow: 0 0 0 2px …`; offline/connecting
states animate `avatar-issue-pulse-error` / `-warning` (2.4s pulse, CSS in
`tailwind.css`).

### Badges & status pills — `primitives/Badge.tsx`, `StatusBadge.tsx`, `src/renderer/statusBadge.js`
Pill: `rounded-full px-3 text-[10px] font-bold uppercase tracking-wider` and
**always `border border-outline`** (a deliberate border). `statusBadge.js` maps
file/share state onto a **fixed 5-token palette**, each token one fixed meaning:
🟢 `bg-success` (on your device — `mine` + `downloaded`/`synced`),
🔵 `bg-info` (in transfer — `downloading` / `preparing` / `verifying` (`animate-pulse`) / `publishing`),
🟡 `bg-warning` (needs attention — `paused-interrupted`, folder `missing`/`mount-point-gone`),
🔴 `bg-error-container` (`error` only),
⚪ `bg-surface-container-highest` (passive / not-here / **all folder roles** — `mine`/`browse`/`mirrored` —
and `available`/`owner-offline`/`unavailable`). Roles carry meaning by label, not color.
The `*-fixed` ramps (`secondary-fixed`, `primary-fixed`) are no longer used by pills.

### Progress bar — `primitives/ProgressBar.tsx`
`h-1.5 bg-surface-container-high rounded-full` track, `bg-secondary-container`
fill, `transition-all motion-reduce:transition-none`, `role="progressbar"`
(no `aria-live` — frequent updates would spam screen readers).

The transfer-row variant — `widgets/DownloadProgressLane.tsx` — adds a meta line
(speed · ETA, ETA alone, or downloaded-so-far) and an **indeterminate** mode used
while the ETA is still warming up (no stable rate yet). Indeterminate renders a
40%-wide `bg-secondary-container` segment that sweeps the track
(`.progress-indeterminate`, keyframe below) and, per the ARIA progressbar contract,
**drops `aria-valuenow`** while carrying the state in `aria-valuetext` (the
"Estimating…" string). Determinate mode keeps `aria-valuenow` + the width fill.

### Collapsible card — `primitives/CollapsibleCard.tsx`
`bg-surface-container-low rounded-2xl p-8`; header button carrying the standard
disclosure chevron (below).

### Disclosure chevron (expand / collapse affordance)
Every expand/collapse control — `CollapsibleCard`, the `NetworkStatus` sections, the
Storage Settings "Show details" row — points **right when collapsed, down when
expanded** (never up), in the muted affordance color **`text-outline`** (not
`text-on-surface-variant`). Two equivalent implementations ship; either is fine, but
match the surrounding screen:
- **Rotate** — a single `chevron_right` with `transition-transform duration-200` and
  `rotate-90` when open (animates right → down). Used by `CollapsibleCard`.
- **Swap** — `name={open ? 'expand_more' : 'chevron_right'}`, no animation. Used by
  `NetworkStatus` and `StorageSettings`.
Never use `expand_more` + `rotate-180` (a down → up flip): the resting state must be a
right-pointing chevron, so a closed row reads as "opens downward."

### Drop zone — `components/widgets/DropZone.tsx` + `DropOverlay.tsx`
Resting zone: `border-2 border-dashed border-outline bg-surface-container-low rounded-2xl` —
the "Drop to Share" title + "Share…" picker. A drag anywhere over the space-view content
grid promotes it to a full-bleed **`DropOverlay`** (`absolute inset-x-0 bottom-0 top-16`,
same dashed `border-secondary` + `bg-surface-container-high/90` tint as the legacy drag-over
state, scaled up, with the file/folder icon + "Release to share …" subline). The resting
zone crossfades out (`transition-opacity`) as the overlay fades in. Detection lives at the
grid root (`useDragShare`, `hooks/`); the overlay is `aria-hidden` (pointer-only — keyboard/AT
use the "Share…" menu). Crossfade respects `prefers-reduced-motion`.

### Icons — `primitives/Icon.tsx`
Inline **Material Symbols** SVG paths (`viewBox="0 -960 960 960"`,
`fill="currentColor"`), outlined default with a filled subset, ~68 icons.
Default size 24. `aria-hidden` unless `ariaLabel` is provided. No icon font, no
sprite sheet. File-type icon mapping lives in `src/renderer/fileIcon.js`.

### Logo — `primitives/Logo.tsx`
The Mirall wordmark, inline SVG (`viewBox="0 0 2835 844"`, so height drives
width — default `h-5 w-auto`). Lettering is `currentColor`, so the caller sets
the theme with a text colour (`text-black dark:text-white` in TopNav,
`text-on-surface` in Onboarding) and one component covers both the black and
white brand exports. The dot is a literal `#fd9c42`, **not**
`secondary-container` — that token goes muted brown in dark, and the signature
orange must not. `aria-hidden` unless a `label` is passed, since the top bar
already names its home button. Source of truth:
`resources/brand/mirall-logo.svg`.

**No hover treatment.** The logo button carries `active:scale-95` and the focus
ring only. A hover fade reads as a *colour* change on a wordmark painted in the
surface's own text colour — white lettering at 80% over the dark bar is a grey
logo. Pinned by `npm run test:layout:logohover`.

---

## 8. Motion & accessibility

- Global `@media (prefers-reduced-motion: reduce)` neutralizes all
  animations/transitions (`tailwind.css`).
- Universal visible focus ring (see §7).
- Keyframes: `avatar-issue-pulse` (2.4s), `leave-progress-stripe-shift`
  (1.4s diagonal stripe used by leave-progress), and `progress-indeterminate-sweep`
  (1.4s; the warmup sweep on `DownloadProgressLane`, reduced to a static 40%-opacity
  fill under `prefers-reduced-motion`).
- Standardized thin scrollbar (`.scrollbar-thin`), resolving against
  `color-scheme`.
- Accessibility is CI/locally gated — see `.claude/testing.md`. Every control
  must be reachable and identifiable by name/role/state.

---

## 9. Platform chrome

The window is frameless (`frame: false`); the app draws its own chrome.
`pear-ctrl` (a Pear-runtime shadow-DOM custom element) is themed per platform
purely in CSS via a `--mirall-ctrl-color` custom property on
`[data-platform] pear-ctrl` rules in `tailwind.css` (no JS stylesheet injection):
macOS shows native traffic lights via
Electron's overlay; Windows/Linux render custom min/max/close cells. TopNav is a
drag region (`WebkitAppRegion: 'drag'`) with `no-drag` islands for controls; a
`data-platform` attribute on the root drives platform-specific CSS.

---

## 10. Conventions

**Do**
- Use semantic tokens; lean on the `surface-container-*` ramp for hierarchy.
- Match the radius to element size (the §5 ladder).
- Carry destructive intent with the `danger` button, not red titles.
- Give every control a name/role/state and rely on the universal focus ring.
- Keep ambient shadows purple-tinted (`rgba(74,59,82,…)`).

**Don't**
- Don't introduce CSS gradients or new glass surfaces — glass is limited to the
  nav/onboarding header and the modal backdrop; panels are opaque.
- Don't use `#000` for text or pure-black shadows outside the modal panel.
- Don't add 1px layout borders. Borders are reserved for the few intentional
  cases (badge outline, dashed dropzone, the storage divider).
- Don't invent a named type scale — use Tailwind sizes + `font-headline`.
- Don't hardcode hex in components (the space-icon palette is the only exception).
