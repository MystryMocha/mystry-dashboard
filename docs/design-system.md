# Design System

How the Mystry Dashboard web UI looks, reads and is put together. Use it when you design or build a page, a component or user-visible copy in `apps/web`. Writing rules for each language and right-to-left layout are in [Localization](localization.md).

- **Source of truth:** [`apps/web/src/styles.css`](../apps/web/src/styles.css) (tokens and every component class) and [`apps/web/src/i18n/`](../apps/web/src/i18n/) (copy). If this page and the code disagree, the code wins — fix this page in the same change.
- **Visual reference:** a browsable copy with live component previews in both themes lives in the [Mystry Dashboard Design System artifact](https://claude.ai/artifact/L1qMsnhfkv7rZ68ifVdke6) (private; ask the owner for access). It is a snapshot synced from `styles.css` at `edfb414` and does not update on its own.
- Token names below are CSS custom properties in `styles.css`: `accent` means `var(--accent)`. Font sizes are `--text-*` tokens; other values written in px are literals in the source, not variables.

## Content

- **Plain, direct language; address the user as "you".** No exclamation marks, no jokes, no emoji. Say what will happen and what will not: "Copy an existing server from a folder on this machine, or upload a server ZIP. Your original files are never changed or deleted."
- **Buttons are verbs**, one to three words: "Start", "Reload", "Choose ZIP". Destructive confirmations name the consequence: "Force Stop", "Delete Permanently", "Remove Record".
- **Page titles are nouns**: "Instances", "Quick Deploy", "Import Server", "This Machine". The subtitle is one sentence that says what the page does.
- **Status words are fixed** and come from the glossary in `apps/web/src/i18n/en/common.ts`: Stopped, Starting, Running, Stopping, Crashed, Needs Migration; tasks are Queued, In Progress, Completed, Failed.
- **Empty states give the next step** (title + one sentence + a primary button, or, where there are several ways to start, a list of full-row choices with one sentence each, as on the empty overview); **errors give the cause and the way out**, never only a code.
- Keep technical names untranslated: `Paper`, `Fabric`, `JVM`, `server.properties`, `ZIP`. Put a space between a number and its unit (`4 GB`, `3 / 5`).
- Every string lives in the locale tables, never inline in a component — see [Localization](localization.md).

## Visual foundations

### Two materials

The most important rule of the system:

- **Navigation layer** — sidebar, toolbar button groups, pop-up menus, popovers, the floating action bar, the narrow-screen tab bar — is glass: `material`, `material-thick` or `menu-bg`, plus `backdrop-filter: blur(24–40px) saturate(180%)` and the `glass-edge` hairline.
- **The toolbar has no bar of its own.** Its page title (shown once the content scrolls) and its button group are separate floating glass capsules, like the sidebar and the action bar. When content scrolls under them, `.topbar::before` adds a scroll edge: a light blur masked to fade out downward, never a full-width band with a hard bottom line.
- **Below 768px only the tab bar keeps the blur.** The toolbar title capsule, its button groups, the sidebar drawer and the floating action bar drop `backdrop-filter` and use the near-opaque `material-flat`; the toolbar scroll edge drops its blur and fades from `bg` at 94%; the task drawer keeps `sheet-bg` without blur, and dialogs switch to the opaque `sheet-bg-solid` (translucent without blur lets text behind show through). Stacked blur layers on the same part of the screen are too costly for phone GPUs. Transient menus and popovers keep their blur.
- **Content layer** — page content sits directly on the page background, not on cards. Form sections are a title, a `separator-strong` rule and the fields; grouped lists, the server list and empty states sit between two `separator-strong` rules with `separator` hairlines between rows; the deploy guide is set off by a vertical rule. Type, spacing and rules carry the hierarchy instead of stacked cards. The selector `.page :is(.form-card, .list-group):not(dialog *)` and its siblings in `styles.css` do this, so the same classes inside a native `<dialog>` keep their solid `surface`. Solid `surface` with `card-shadow` remains for things that are picked or float: the deploy core tiles, the login card, the migration panel, dialogs and the task drawer. Never put glass on content, and never make the navigation layer solid.
- The page background is flat `bg`, with no gradient wash behind it.

### Color

- Appearance is `data-appearance="light|dark"` on `<html>` (Auto resolves to one of the two); the dark values live under `:root[data-appearance='dark']`.
- Text: `label` (primary), `label-2` (secondary, descriptions, field labels), `label-3` (placeholders, chevrons and separators only — under 4.5:1, never body text).
- Fills: `fill-2` (hover, stats panels), `fill` (default buttons, tracks, badges), `fill-strong` (spinner track). Inputs use `input-bg` with no border; on focus they turn `surface` with a 1px `accent` outline and a 4px `focus-ring` glow.
- **The accent is a fixed ink purple**, not a user setting: fill `#6439e0` and text `#5a30d4` in light, fill `#6a48e6` and text `#ab98ff` in dark, with white `on-accent` in both. Green, orange and red already mean Running, Starting and Crashed, so a purple accent never reads as a status and is never confused with the red Stop beside it. Refer only to `accent` (fills), `accent-text` (links, plain buttons, nav icons) and `on-accent` (text on an accent fill); never write the hex values in a component. `accent-soft` (13%), `accent-soft-strong` (20%) and `focus-ring` (45%) are derived with `color-mix`; `console-focus` is the accent mixed with 35% white, so it stays above 5.6:1 on the always-dark console.
- **Semantic color comes in two sets.** `c-green`, `c-blue`, `c-purple`, `c-orange`, `c-red`, `c-gray` are tones for fills and icons only (components set them as `--tone` and mix them into the background at 11–16%). Text uses `ok`, `warn` and `danger`, tuned so they stay at 4.5:1 or above on their own 11–16% tint over `bg` (the worst case for status pills, tinted buttons and callouts): deeper than the system colors in light, and in dark `danger` is one step lighter than `c-red`. A solid destructive button is `danger-fill` with white text; in dark it is one step deeper than `c-red`, so it is no longer the same value as `danger`.
- Status mapping: Running → green; Starting, Stopping, Needs Migration → orange; Crashed and Failed → red; Stopped → gray. A status always carries its word, never color alone.
- **The console is always dark** in both appearances: `#161618` window, `#1f1f22` bars, `#e5e5ea` text, `#aeaeb2` muted, `#30d158` prompt. Its input and tool focus rings use `console-focus`, never a fixed blue.
- Brand color appears only on the brand mark: a 145° gradient `#ff73b0` → `#c64fd6` (52%) → `#7a4df0`. The accent takes the hue of the gradient's violet end but is its own deeper token, so the gradient itself still appears nowhere else: it is the only gradient in the interface. Each server core has one solid color (`.core-paper`, `.core-fabric`, … set `--core`), used only on core icons, with no gradient or colored shadow; the white glyph stays at 3:1 or above on it. The user avatar and the This Machine icon are solid gray.

### Type

- System font stack in `--font`, no web fonts, so first paint never waits on a font service. `:root:lang(zh-TW)` puts the Traditional Chinese fonts first. Monospace is `--mono`.
- Body is 15px / 1.47 with -0.005em tracking; titles tighten to -0.015 to -0.026em.
- **Font sizes come only from the scale in `:root`**, chosen by role; never write a px font size or a half-pixel step in a component:

  | Token | Size | Used for |
  |---|---|---|
  | `text-large` | 30px | The one large title per page, the instance name, the login title |
  | `text-title` | 22px | Section titles, the overview status sentence, the task drawer title; the instance name below 768px |
  | `text-headline` | 17px | Dialog and empty-state titles, server names, `.btn-lg` |
  | `text-input` | 16px | Text inputs on touch screens and the login fields (see below); not a style step |
  | `text-body` | 15px | Body, buttons, nav items, menu items, list titles, inputs, instance tabs |
  | `text-small` | 13px | Field labels (semibold), help and descriptions, status pills, chips, `.btn-sm`, metadata; instance tabs below 480px |
  | `text-footnote` | 12px | Code, paths, timestamps, fine print, count badges |
  | `text-micro` | 11px | Tab bar labels and toolbar badges only |

  Sizes that sit next to each other differ by weight or color as well as size (a field label is 13px semibold `label-2`, its help 13px regular `label-2` after it).
- Numbers use `font-variant-numeric: tabular-nums` (metrics, badges, file sizes, progress). Overview meter values stay on one line and clip with an ellipsis instead of wrapping.
- On touch screens (`pointer: coarse`) and below 768px every text input, select and textarea is at least 16px, so iOS does not zoom the page on focus.
- JVM arguments, paths, commands and file contents use `--mono` at 13px / 1.55.

### Shape and spacing

- **Concentric corners**, larger outside and smaller inside: `radius-xl` 22px (sidebar, dialogs) > `radius-lg` 18px (cards) > `radius-md` 14px (lists, callouts, menus) > `radius-sm` 10px (inputs) > `radius-xs` 7px.
- **Every button, chip, segmented control, status pill and progress bar is a pill** (`radius-pill`).
- Control heights: buttons 34px (`.btn-sm` 28px, `.btn-lg` 46px); inputs at least 38px.
- **Touch targets (`pointer: coarse`) are at least 44×44px.** Buttons, icon buttons, toolbar buttons, segmented items, menu items, nav items, list options, chips, console tools, disclosure summaries and form fields grow to 44px; `.btn-sm`, `.link-button` and `.back-link` keep their look and extend an invisible `::after` hit area to 44px, and each overview server row is one large target: its name link stretches over the whole row. Inline links inside a sentence are exempt. Desktop density does not change.
- Skeleton: 24px between page blocks (`.page`), 16px in grids, 14px under section titles, 18px card padding, 40px side margins (28px ≤1024px, 16px ≤768px), `content-max` 1240px, `sidebar-width` 256px, `toolbar-height` 60px.
- Dividers are 0.5px `separator` and start at the row's left padding, not the card edge.

### Shadows

- The remaining cards (core tiles, login, migration panel) use `card-shadow`. Core tiles do not lift or deepen their shadow on hover; they take the same `hover-overlay` as buttons. Floating elements use `float-shadow`; dialogs and the task drawer use `sheet-shadow`. In dark, cards keep only a faint outline.

### Interaction and motion

- Hover lays `hover-overlay` over the background; press lays `active-overlay` and scales to 0.97. Disabled is 0.42 opacity with a not-allowed cursor.
- Focus: `:focus-visible` draws a 3px `focus-ring` outline offset by 2px; inputs use the glow instead.
- `--ease` for most transitions, `--ease-spring` for dialogs, drawers and switch knobs; hover 0.15s, entrances 0.16–0.38s.
- Only states that are still changing loop: the Starting and Stopping status dots and the connecting console dot blink (opacity only). Running is a steady state and its dot stays still, so a list with several running servers does not flicker. Loading spinners rotate.
- `prefers-reduced-motion` turns off entrances and the blinking status dots; loading spinners stay.

### Responsive

- The overview server list stacks each row (identity, then state, then actions) when the list section is 820px or narrower, measured with a container query rather than the viewport; at 520px or narrower the row actions share the row equally.
- Long forms go two columns when the page content area (a `page` container query on `.page`) is 900px or wider: wrap the sections in `.form-columns`, one `.form-column` per column, and keep the narrow reading order (columns stack in DOM order). Balance the columns by height, putting a short section such as the EULA card under the shorter column. Config groups use `.config-groups` the same way, with narrower controls in half columns. On Quick Deploy the five core tiles share one row once the form column is 640px wide; below that they stay 3+2, never 4+1.
- Multiplayer reuses the Quick Deploy two-column grid (`deploy-layout` + `deploy-guide`) through `MultiplayerLayout`. The main column follows the task: an `OpenSwitch` row ("Open This Instance to Players", applies immediately, sends only server-side saved settings, hidden until the client is installed and, for frp, until the tunnel settings were saved once), then `JoinSteps` ("Let Players Join", numbered because the steps are a real sequence, with the join address one size up in `multiplayer-join-address`), then advanced settings in a `disclosure` that opens by default only when it holds non-default values. The guide column holds only what people read when something goes wrong or when they want an explanation (tunnel modes, troubleshooting); anything that makes joining fail if skipped (start the server, run as administrator on Windows, keep the secret private) stays in the main column next to the control it concerns, because below 1180px the guide drops to the bottom of the page. The guide can be closed (`is-guide-closed` makes the main column full width) and the choice lives in `localStorage` as a per-browser convenience. The instance select (max 320px) and the method switch share one row in `multiplayer-toolbar`.
- Native `<select>` options get an opaque `surface-raised` background and `label` text: Windows paints the popup from the select's translucent `input-bg`, which turns light grey with white text in dark appearance.
- ≤1024px: the sidebar becomes a drawer under the toolbar; toolbar button labels hide.
- ≤768px: a glass tab bar appears at the bottom and becomes the only blurred navigation layer, dialogs become bottom sheets and buttons fill the row; the import-mode switch drops its icons.
- ≤480px: page-header and instance actions share the row equally; the instance tabs drop their icons.

### Accessibility notes

Text pairs built from `label`, `label-2`, `ok`, `warn`, `danger`, `accent-text` and `on-accent` reach 4.5:1 in both appearances, including on their 11–16% tints over `bg`. For the accent: white on the fill is 6.6:1 in light and 5.7:1 in dark; `accent-text` is 6.9:1 / 8.2:1 on `bg` and 5.0:1 / 7.1:1 on its own 20% tint. When you change any of these tokens, recheck the tinted cases (status pills, `btn-ok`, `btn-danger`, `btn-tinted`, callouts), not only text on `surface`.

These pairs still fall below 4.5:1; do not widen their use: `label-3` on `input-bg` (placeholders, about 2.6–2.9:1) and on `surface` (about 3.3:1), and the white task icons on `c-green` / `c-orange` (about 2.2:1).

## Iconography

- [Lucide](https://lucide.dev) via `lucide-react`: line icons with a 2px stroke and round caps, colored by `currentColor`. No other icon sets, no emoji.
- Sizes: navigation 17px, buttons 14–16px, menus 16px, file rows 18–20px, empty states 30px, drop zone 28px.
- Navigation icons use `accent-text` and follow `on-accent` when selected; menu icons use `label-2`.
- The brand mark is `BrandMark` ([`components/BrandMark.tsx`](../apps/web/src/components/BrandMark.tsx)): the box outline on the brand-gradient rounded square at 24, 32 and 84px. There is no wordmark; set "Mystry Dashboard" beside it in `.brand-title` when the name is needed.

## Components

The class names to reach for. Each one is a plain CSS class in `styles.css`; the React components named in brackets wrap them.

| Component | Classes | Notes |
|---|---|---|
| Button | `btn` + `btn-primary` / `btn-tinted` / `btn-plain` / `btn-ok` / `btn-danger` / `btn-destructive`; sizes `btn-sm`, `btn-lg`, `btn-icon`, `btn-block`; `link-button` | One `btn-primary` per screen; `btn-destructive` only for irreversible confirmations |
| Chip | `chip`, `chip-mono`, `chip-desc` in `quick-cmd-bar` | Quick picks such as console commands |
| Segmented control | `segmented`, `segmented-item` (`active`) | Sibling views of the same content (filters, import or multiplayer mode) |
| Instance tabs | `hub-tabs`, `hub-tab` (`active`) | Underlined text tabs on a full-width `separator-strong` rule; the current tab is semibold with a 2px `accent` bar and an `accent-text` icon. Scrolls sideways when it does not fit |
| Toolbar group | `toolbar-group`, `toolbar-button`, `toolbar-badge` | Glass; labels hide below 1024px |
| Toolbar title | `toolbar-title` | Glass capsule, 42px tall like the button group; fades in once the content scrolls |
| Sidebar | `sidebar`, `sidebar-brand`, `nav-section`, `nav-header`, `nav-item` (`active`), `sidebar-footer` | Drawer below 1024px |
| Breadcrumbs | `breadcrumbs`, `breadcrumb-item`, `breadcrumb`, `breadcrumb-sep` | Current level has `aria-current="page"` |
| Field | `field`, `field-help`, `field-warn`, `error`, `input`, `input-row`, `grid grid-2` | Borderless filled controls |
| Switch / checkbox | `switch` (`role="switch"`), `checkbox-field` | Switch applies immediately; checkbox is submitted |
| Card and sections | `card`, `form-card`, `page-section`, `section-header`, `section-title`, `count-badge`, `form-section-title`, `step-badge` | Keep writing `card form-card` for a form section: on a page it renders as a ruled section with no surface, in a dialog as a solid card. No glass, no colored side stripes |
| Grouped list | `list-group`, `list-row`, `list-row-text`, `list-row-title`, `list-row-desc`, `list-row-control`, `list-row-value` | On a page: rows flush with the content edge between two `separator-strong` rules; in a dialog: iOS Settings style on `surface` |
| Disclosure | `details.disclosure` | Advanced options only |
| QR code | `qr-code` inside `remote-qr` | Always black on white with a quiet zone, in both appearances, so it scans; drawn as inline SVG by `QrCode.tsx` |
| Copyable value | `direct-address`, `direct-command`, `remote-url`, `remote-join-value` | Monospace, `user-select: all`; copy with `copyText()` from `clipboard.ts`, which also works outside a secure context |
| Action bar | `action-bar`, `action-bar-status` | One per page, sticky at the bottom |
| Callout | `callout` + `callout-info` / `callout-success` / `callout-warning` / `callout-danger`, `callout-icon` | Body stays `label`; only `<strong>` turns `danger` |
| Ready strip | `ready-strip`, `ready-strip-icon`, `ready-strip-text` | One line above the console once the server is ready: green only on the icon and a 9% tint, a small tinted Invite Friends button and an icon-only dismiss [`ReadyHint`] |
| Status pill | `status-pill` + `running` / `stopped` / `starting` / `stopping` / `crashed` / `warning`, `status-dot` | [`StatusPill`, `InstanceStatusPill`] |
| Progress | `progress`, `progress-fill`, `task-progress`, `spinner`, `spinner-sm`, `page-loading` | Tasks stay visible until Completed or Failed |
| Empty state | `empty-state`, `empty-icon`, `empty-actions`, `empty-state-compact` | Title + next step + primary button; on a page it sits between two rules like an empty list |
| Task card | `task-card status-<status>`, `task-card-head`, `task-card-icon`, `task-card-message`, `task-card-error`, `task-card-foot` | Inside the `task-drawer` [`TaskCenter`] |
| Meter | `meter` (`is-neutral` / `is-accent` / `is-warning`), `meter-fill` | 4px usage bar, decorative; the number always sits beside it [`Meter`] |
| Host strip | `host-strip`, `host-meters`, `host-meter`, `metrics-status` | This machine's CPU, memory and data disk in one row directly on the page background, no panel, so it stays quieter than the server list [`HostMeters`] |
| Server list | `server-section`, `server-list`, `server-row`, `server-id`, `server-state`, `server-sentence` (`is-ok` / `is-warn` / `is-danger`), `server-figures`, `server-actions` | One row per instance; rows share the list's columns through `subgrid` so the state column lines up. The status pill is followed by one sentence about what the user can do now, and the row offers that next step (Invite Friends, Open Settings, Review EULA, Open Console) before Start / Stop. The whole row opens the instance: the name link's `::after` covers the row, buttons sit above it, the row tints with `hover-overlay` on hover, draws the focus ring when the name has keyboard focus, and ends with a `label-3` chevron. No card surface: the list sits on the page background between two `separator-strong` rules (it extends 12px past the content edge on each side so the rounded hover tint has room while the icons stay aligned), and rows are divided by `separator` hairlines that start at the name column. On wide rows Start, Stop and the more button have no fill until hovered, so the tinted next-step button is the one emphasized action per row; once rows stack, Start and Stop get their tint back |
| Overview status | `overview-status`, `overview-status-issues` | The overview subtitle as a 22px status sentence ("6 instances, 2 running"); a count of instances that need attention follows in `danger` |
| Start paths | `start-paths`, `start-path-list`, `start-path` | Empty overview: three ways to add a first server, each a full-row link with one sentence |
| File list | `files-toolbar`, `file-list list-group`, `file-row`, `file-main`, `file-icon is-dir|is-file` | [`FilesTab`] |
| Brand mark / core icon | `brand-mark brand-mark-<size>`, `core-icon core-<type>` | [`BrandMark`, `CoreIcon`] |
| Menu | `action-menu-trigger`, `action-menu-panel`, `menu-item` (`is-danger`) | Attached to `<body>` with fixed coordinates [`ActionMenu`] |
| Dialog | `confirm-dialog`, `confirm-dialog-panel`, `confirm-dialog-title` / `-body` / `-footer` | Native `<dialog>`; bottom sheet below 768px [`ConfirmDialog`] |
| Popovers | `popover`, `appearance-*`, `accent-*`, `language-options` | [`ThemeToggle`, `LanguageToggle`] |
| Console | `console-window`, `console-header-bar`, `console-status`, `console-tool`, `console-output`, `console-input-bar` | Always dark [`ConsolePanel`] |
| Drop zone | `drop-zone` (`is-dragging`, `has-file`, `is-disabled`) | Inside a `field` |

## Building a page

1. Page skeleton: `.page` holds a `.page-header` (via `PageHeader`: `.large-title`, `.page-subtitle`, actions on the right) followed by `.page-section` blocks. Form pages put the main action in an `.action-bar`.
2. Reuse the classes above before adding new ones; new values that repeat belong in the `:root` blocks of `styles.css`, with a dark-appearance value when they are colors.
3. Write copy into the locale tables, then check the page in light and dark, every shipped language and at 375px, as [UI 与交互](ai/change-playbooks.md#ui-与交互) requires.
4. Run the template check below on the screenshots, not only on the code.

## Template check

A choice is "templated" when you would have made it the same way for any other product. Before you ship a page, look for these and keep one only when you can say what it tells the user:

- **Structure:** content chopped into identical cards; one radius and one grey shadow on everything; numbered markers (01 / 02 / 03) on things that are not steps; a big number with a small label where one sentence would do (the overview says "3 instances, 1 running, 1 needs attention" instead of stat tiles); gradient washes as decoration.
- **Type:** one word in a heading set apart in italic, bold or color; ALL-CAPS or widely tracked labels; a small label above a heading that repeats it; many sizes close to each other instead of a few clear steps; a monospace face for small data labels (monospace is for logs, commands and paths).
- **Chrome:** middle dots (`A · B`) between things of different kinds, such as a label and its state ("Live log connected", not "Live log · Connected") or a figure and a remark (write two sentences). Dots stay only between metadata of the same kind: size, time, count, version and path, as in a file row or a backup row; labels built as `WORD — fragment`; a `→` after button or link text (an arrow that shows a click path, as in "Advanced → Proceed", is information and stays).
- **Color:** the accent used as decoration rather than for what you can act on and what is selected; new hues or tints that are not tokens.
- **Motion:** entrances on every section or hover transitions on every row. Motion answers an action (open, expand, confirm) and respects reduced motion.
- **Copy:** selling instead of describing; filler sentences; an error that apologizes or does not say how to fix it; one action called by two names in the same flow.

Spend boldness in one place per page, keep the rest quiet, and remove one thing before you finish.
