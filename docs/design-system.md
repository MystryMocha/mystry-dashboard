# Design System

How the Mystry Dashboard web UI looks, reads and is put together. Use it when you design or build a page, a component or user-visible copy in `apps/web`. Writing rules for each language and right-to-left layout are in [Localization](localization.md).

- **Source of truth:** [`apps/web/src/styles.css`](../apps/web/src/styles.css) (tokens and every component class) and [`apps/web/src/i18n/`](../apps/web/src/i18n/) (copy). If this page and the code disagree, the code wins — fix this page in the same change.
- **Visual reference:** a browsable copy with live component previews in both themes lives in the [Mystry Dashboard Design System artifact](https://claude.ai/artifact/L1qMsnhfkv7rZ68ifVdke6) (private; ask the owner for access). It is a snapshot synced from `styles.css` at `edfb414` and does not update on its own.
- Token names below are CSS custom properties in `styles.css`: `accent` means `var(--accent)`. Values written in px are literals in the source, not variables.

## Content

- **Plain, direct language; address the user as "you".** No exclamation marks, no jokes, no emoji. Say what will happen and what will not: "Copy an existing server from a folder on this machine, or upload a server ZIP. Your original files are never changed or deleted."
- **Buttons are verbs**, one to three words: "Start", "Reload", "Choose ZIP". Destructive confirmations name the consequence: "Force Stop", "Delete Permanently", "Remove Record".
- **Page titles are nouns**: "Instances", "Quick Deploy", "Import Server", "This Machine". The subtitle is one sentence that says what the page does.
- **Status words are fixed** and come from the glossary in `apps/web/src/i18n/en/common.ts`: Stopped, Starting, Running, Stopping, Crashed, Needs Migration; tasks are Queued, In Progress, Completed, Failed.
- **Empty states give the next step** (title + one sentence + a primary button); **errors give the cause and the way out**, never only a code.
- Keep technical names untranslated: `Paper`, `Fabric`, `JVM`, `server.properties`, `ZIP`. Put a space between a number and its unit (`4 GB`, `3 / 5`).
- Every string lives in the locale tables, never inline in a component — see [Localization](localization.md).

## Visual foundations

### Two materials

The most important rule of the system:

- **Navigation layer** — sidebar, toolbar button groups, pop-up menus, popovers, the floating action bar, the narrow-screen tab bar — is glass: `material`, `material-thick` or `menu-bg`, plus `backdrop-filter: blur(24–40px) saturate(180%)` and the `glass-edge` hairline.
- **The toolbar has no bar of its own.** Its page title (shown once the content scrolls) and its button group are separate floating glass capsules, like the sidebar and the action bar. When content scrolls under them, `.topbar::before` adds a scroll edge: a light blur masked to fade out downward, never a full-width band with a hard bottom line.
- **Below 768px only the tab bar keeps the blur.** The toolbar title capsule, its button groups, the sidebar drawer and the floating action bar drop `backdrop-filter` and use the near-opaque `material-flat`; the toolbar scroll edge drops its blur and fades from `bg` at 94%; the task drawer keeps `sheet-bg` without blur, and dialogs switch to the opaque `sheet-bg-solid` (translucent without blur lets text behind show through). Stacked blur layers on the same part of the screen are too costly for phone GPUs. Transient menus and popovers keep their blur.
- **Content layer** — cards, instance cards, widgets, grouped lists — is solid `surface` with `card-shadow`. Never put glass on a content card, and never make the navigation layer solid.
- The page background is `bg` under two faint radial gradients, `wallpaper-1` (mixed from the accent) at the top left and `wallpaper-2` at the bottom right.

### Color

- Appearance is `data-appearance="light|dark"` on `<html>` (Auto resolves to one of the two); the dark values live under `:root[data-appearance='dark']`.
- Text: `label` (primary), `label-2` (secondary, descriptions, field labels), `label-3` (placeholders, chevrons and separators only — under 4.5:1, never body text).
- Fills: `fill-2` (hover, stats panels), `fill` (default buttons, tracks, badges), `fill-strong` (spinner track). Inputs use `input-bg` with no border; on focus they turn `surface` with a 1px `accent` outline and a 4px `focus-ring` glow.
- **The accent is the user's choice** — `data-accent="blue|purple|pink|green|graphite"`, blue by default. Refer only to `accent` (fills), `accent-text` (links, plain buttons, nav icons) and `on-accent` (text on an accent fill); never hard-code one accent. In dark, blue and purple keep white `on-accent` on a fill one step deeper than the system color; pink, green and graphite switch to dark `on-accent`. `accent-soft` (13%), `accent-soft-strong` (20%) and `focus-ring` (45%) are derived with `color-mix`; `console-focus` is the accent mixed with 35% white, so it follows the accent and stays at 3:1 or above on the always-dark console.
- **Semantic color comes in two sets.** `c-green`, `c-blue`, `c-purple`, `c-orange`, `c-red`, `c-gray` are tones for fills and icons only (components set them as `--tone` and mix them into the background at 11–16%). Text uses `ok`, `warn` and `danger`, tuned so they stay at 4.5:1 or above on their own 11–16% tint over `bg` (the worst case for status pills, tinted buttons and callouts): deeper than the system colors in light, and in dark `danger` is one step lighter than `c-red`. A solid destructive button is `danger-fill` with white text; in dark it is one step deeper than `c-red`, so it is no longer the same value as `danger`.
- Status mapping: Running → green; Starting, Stopping, Needs Migration → orange; Crashed and Failed → red; Stopped → gray. A status always carries its word, never color alone.
- **The console is always dark** in both appearances: `#161618` window, `#1f1f22` bars, `#e5e5ea` text, `#aeaeb2` muted, `#30d158` prompt. Its input and tool focus rings use `console-focus`, never a fixed blue.
- Brand color appears only on the brand mark: a 145° gradient `#ff73b0` → `#c64fd6` (52%) → `#7a4df0`. Each server core has its own gradient pair (`.core-paper`, `.core-fabric`, … set `--core-a` / `--core-b`), used only on core icons.

### Type

- System font stack in `--font`, no web fonts, so first paint never waits on a font service. `:root:lang(zh-TW)` puts the Traditional Chinese fonts first. Monospace is `--mono`.
- Body is 15px / 1.47 with -0.005em tracking; titles tighten to -0.015 to -0.026em.
- Hierarchy: `.large-title` 32px (one per page; 28px below 768px) → `.section-title` 20px → instance name 16px semibold → form step and toolbar titles 15px semibold → body 15px → field labels 13px semibold → help and metadata 12.5px.
- Numbers use `font-variant-numeric: tabular-nums` (metrics, badges, file sizes, progress). Overview widget values never wrap: they scale with the widget width (`clamp(19px, 11.5cqi, 26px)`, `.widget` is a size container) and stay on one line.
- On touch screens (`pointer: coarse`) and below 768px every text input, select and textarea is at least 16px, so iOS does not zoom the page on focus.
- JVM arguments, paths, commands and file contents use `--mono` at 13px / 1.55.

### Shape and spacing

- **Concentric corners**, larger outside and smaller inside: `radius-xl` 22px (sidebar, dialogs) > `radius-lg` 18px (cards, widgets) > `radius-md` 14px (lists, callouts, menus) > `radius-sm` 10px (inputs) > `radius-xs` 7px.
- **Every button, chip, segmented control, status pill and progress bar is a pill** (`radius-pill`).
- Control heights: buttons 34px (`.btn-sm` 28px, `.btn-lg` 46px); inputs at least 38px.
- **Touch targets (`pointer: coarse`) are at least 44×44px.** Buttons, icon buttons, toolbar buttons, segmented items, menu items, nav items, list options, chips, console tools, disclosure summaries and form fields grow to 44px; `.btn-sm`, `.link-button` and `.back-link` keep their look and extend an invisible `::after` hit area to 44px, and the instance card name (which clips with `overflow: hidden`) uses padding with an equal negative margin. Inline links inside a sentence are exempt. Desktop density does not change.
- Skeleton: 24px between page blocks (`.page`), 16px in grids, 14px under section titles, 18px card padding, 40px side margins (28px ≤1024px, 16px ≤768px), `content-max` 1240px, `sidebar-width` 256px, `toolbar-height` 60px.
- Dividers are 0.5px `separator` and start at the row's left padding, not the card edge.

### Shadows

- Content cards use `card-shadow`; on hover `card-shadow-hover` and a 2px lift. Floating elements use `float-shadow`; dialogs and the task drawer use `sheet-shadow`. In dark, cards keep only a faint outline.

### Interaction and motion

- Hover lays `hover-overlay` over the background; press lays `active-overlay` and scales to 0.97. Disabled is 0.42 opacity with a not-allowed cursor.
- Focus: `:focus-visible` draws a 3px `focus-ring` outline offset by 2px; inputs use the glow instead.
- `--ease` for most transitions, `--ease-spring` for dialogs, drawers and switch knobs; hover 0.15s, entrances 0.16–0.38s.
- Looping animations touch only `transform` and `opacity`: the running status dot breathes with a `::after` that scales up and fades out, never an animated `box-shadow`.
- `prefers-reduced-motion` turns off entrances, lifts and the status-dot breathing; loading spinners stay.

### Responsive

- ≤1180px: the widget grid goes from four columns to two.
- ≤1024px: the sidebar becomes a drawer under the toolbar; toolbar button labels hide.
- ≤768px: a glass tab bar appears at the bottom and becomes the only blurred navigation layer, dialogs become bottom sheets and buttons fill the row; the import-mode switch drops its icons.
- ≤480px: page-header and instance actions share the row equally; the instance tabs drop their icons.

### Accessibility notes

Text pairs built from `label`, `label-2`, `ok`, `warn`, `danger`, `accent-text` and `on-accent` reach 4.5:1 in both appearances and every accent, including on their 11–16% tints over `bg`. When you change any of these tokens, recheck the tinted cases (status pills, `btn-ok`, `btn-danger`, `btn-tinted`, callouts), not only text on `surface`.

These pairs still fall below 4.5:1; do not widen their use: `label-3` on `input-bg` (placeholders, about 2.6–2.9:1) and on `surface` (about 3.3:1), and the white widget and task icons on `c-green` / `c-orange` (about 2.2:1).

## Iconography

- [Lucide](https://lucide.dev) via `lucide-react`: line icons with a 2px stroke and round caps, colored by `currentColor`. No other icon sets, no emoji.
- Sizes: navigation 17px, buttons 14–16px, menus 16px, widgets 14px (stroke 2.4), file rows 18–20px, empty states 30px, drop zone 28px.
- Navigation icons use `accent-text` and follow `on-accent` when selected; menu icons use `label-2`.
- The brand mark is `BrandMark` ([`components/BrandMark.tsx`](../apps/web/src/components/BrandMark.tsx)): the box outline on the brand-gradient rounded square at 24, 32 and 84px. There is no wordmark; set "Mystry Dashboard" beside it in `.brand-title` when the name is needed.

## Components

The class names to reach for. Each one is a plain CSS class in `styles.css`; the React components named in brackets wrap them.

| Component | Classes | Notes |
|---|---|---|
| Button | `btn` + `btn-primary` / `btn-tinted` / `btn-plain` / `btn-ok` / `btn-danger` / `btn-destructive`; sizes `btn-sm`, `btn-lg`, `btn-icon`, `btn-block`; `link-button` | One `btn-primary` per screen; `btn-destructive` only for irreversible confirmations |
| Chip | `chip`, `chip-mono`, `chip-desc` in `quick-cmd-bar` | Quick picks such as console commands |
| Segmented control | `segmented`, `segmented-item` (`active`) | Sibling views; `hub-tabs` for the instance workspace |
| Toolbar group | `toolbar-group`, `toolbar-button`, `toolbar-badge` | Glass; labels hide below 1024px |
| Toolbar title | `toolbar-title` | Glass capsule, 42px tall like the button group; fades in once the content scrolls |
| Sidebar | `sidebar`, `sidebar-brand`, `nav-section`, `nav-header`, `nav-item` (`active`), `sidebar-footer` | Drawer below 1024px |
| Breadcrumbs | `breadcrumbs`, `breadcrumb-item`, `breadcrumb`, `breadcrumb-sep` | Current level has `aria-current="page"` |
| Field | `field`, `field-help`, `field-warn`, `error`, `input`, `input-row`, `grid grid-2` | Borderless filled controls |
| Switch / checkbox | `switch` (`role="switch"`), `checkbox-field` | Switch applies immediately; checkbox is submitted |
| Card and sections | `card`, `form-card`, `page-section`, `section-header`, `section-title`, `count-badge`, `form-section-title`, `step-badge` | No glass, no colored side stripes |
| Grouped list | `list-group`, `list-row`, `list-row-text`, `list-row-title`, `list-row-desc`, `list-row-control`, `list-row-value` | iOS Settings style |
| Disclosure | `details.disclosure` | Advanced options only |
| QR code | `qr-code` inside `remote-qr` | Always black on white with a quiet zone, in both appearances, so it scans; drawn as inline SVG by `QrCode.tsx` |
| Copyable value | `direct-address`, `direct-command`, `remote-url`, `remote-join-value` | Monospace, `user-select: all`; copy with `copyText()` from `clipboard.ts`, which also works outside a secure context |
| Action bar | `action-bar`, `action-bar-status` | One per page, sticky at the bottom |
| Callout | `callout` + `callout-info` / `callout-success` / `callout-warning` / `callout-danger`, `callout-icon` | Body stays `label`; only `<strong>` turns `danger` |
| Status pill | `status-pill` + `running` / `stopped` / `starting` / `stopping` / `crashed` / `warning`, `status-dot` | [`StatusPill`, `InstanceStatusPill`] |
| Progress | `progress`, `progress-fill`, `task-progress`, `spinner`, `spinner-sm`, `page-loading` | Tasks stay visible until Completed or Failed |
| Empty state | `empty-state`, `empty-icon`, `empty-actions`, `empty-state-compact` | Title + next step + primary button |
| Task card | `task-card status-<status>`, `task-card-head`, `task-card-icon`, `task-card-message`, `task-card-error`, `task-card-foot` | Inside the `task-drawer` [`TaskCenter`] |
| Widget | `widget-grid`, `widget tone-<tone>`, `widget-value`, `widget-detail`, `ring` | [`MetricWidget`, `RingGauge`] |
| Instance card | `instance-grid`, `instance-card`, `inst-card-top`, `inst-stats`, `inst-card-actions` | Lifts on hover |
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
3. Write copy into the locale tables, then check the page in light and dark, every accent, every shipped language and at 375px, as [UI 与交互](ai/change-playbooks.md#ui-与交互) requires.
