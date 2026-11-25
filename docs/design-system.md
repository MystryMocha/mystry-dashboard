# Design System

**English** · [简体中文](design-system.zh-CN.md)

How the Mystry Dashboard web UI looks, reads and is built: visual hierarchy, color, type, corners, components and page copy. Use it when designing or building a page, component or user-visible copy in `apps/web`. Per-language writing rules and right-to-left layout are in [Localization](localization.md).

- **Source of truth:** [`apps/web/src/styles.css`](../apps/web/src/styles.css) (tokens and every component class) and [`apps/web/src/i18n/`](../apps/web/src/i18n/) (copy). If this page and the code disagree, the code wins; fix this page in the same change, in both languages.
- **Visual reference:** a browsable copy with live component previews in both themes is in the [Mystry Dashboard Design System artifact](https://claude.ai/artifact/L1qMsnhfkv7rZ68ifVdke6) (private; ask the owner for access). It is a snapshot synced from `styles.css` at `edfb414`, before the content panels and the clay orange accent, and does not update itself.
- Token names below are CSS custom properties in `styles.css`: `accent` means `var(--accent)`. Font sizes are `--text-*` tokens; other values written in px are literals in the source, not variables.

## Content

- **Plain, direct language; address the user as "you".** No exclamation marks, no jokes, no emoji. Say what will happen and what will not.
- **Buttons name the action**: one to three words in English, two to four characters in Chinese ("Start", "Upload Backup", "Choose ZIP"). Irreversible confirmations name the consequence ("Force Stop", "Delete Permanently", "Remove Record").
- **Page titles are nouns**: "Instances", "Quick Deploy", "Import Server", "This Machine", "Panel Settings".
- **No standing explanation at the top of a tab.** Do not open a page with sentences such as "These settings are saved to server.properties and take effect after you restart the instance" or "Each backup is a complete copy". The tab itself and the file manager show where things belong. A limit that applies only at run time shows only while it applies: as a short status tag (the Backups tab's "Stop server to restore" while the server runs), in the save bar or in a confirmation.
- **Background features speak up by severity.** A scheduled backup that completes normally takes no status line of its own; only when the latest run failed does a `callout-danger` give the time of the failure, its reason and when the last one succeeded.
- **Status words are fixed** and come from the glossary in `apps/web/src/i18n/en/common.ts`: Stopped, Starting, Running, Stopping, Crashed, Needs Migration; tasks are Queued, In Progress, Completed, Failed, Cancelled. A cancelled task is still `failed` in the data; the Task Center shows it as Cancelled in neutral gray, because cancelling is not an error.
- **Empty states give the next step** (title + one sentence + a primary button, or full-row choices as on the empty overview); **errors give the cause and the way out**, never only a code.
- Keep technical names untranslated: `Paper`, `Fabric`, `JVM`, `server.properties`, `ZIP`. Put a space between a number and its unit (`4 GB`, `3 / 5`).
- Every string lives in the locale tables, never inline in a component; see [Localization](localization.md).

## Visual foundations

### Three layers, two materials

The UI is split into three layers. This is the most important rule of the system.

1. **Bottom: the page canvas (`bg`).**
   - `#f5f5f7` in light and `#1e1e20` in dark (graphite, as in the macOS dark appearance, not near black), flat, with no decorative gradient.
   - It carries the page title, section titles, the page header actions, the host strip (`.host-strip`) and the reading guide (`.deploy-guide`).

2. **Middle: first-level content panels (macOS and iOS inset grouped surfaces).**
   - Grouped lists (`.list-group`), form groups (`.form-card`), resource lists (the overview `.server-list`, the files `.file-list`, the backups `.backup-list`), the scheduled backup bar (`.backups-schedule`), empty states (`.empty-state.card`) and the empty overview's choices (`.start-path-list`) **all use the same solid rounded panel**:
     - Fill: `surface` (`#ffffff` light / `#2a2a2d` dark, one step lighter than the canvas in dark)
     - Border: `1px solid var(--panel-border)` (`rgba(0, 0, 0, 0.11)` light / `rgba(255, 255, 255, 0.09)` dark)
     - Shadow: `panel-shadow` (light `0 1px 2px rgba(0, 0, 0, 0.05), 0 2px 6px rgba(0, 0, 0, 0.03)`, dark `inset 0 1px 0 rgba(255, 255, 255, 0.04)`); no heavy floating shadow
     - Corners: `radius-md` (14px); lists add `overflow: hidden`
   - Section titles (`.form-section-title`) sit **outside and above** the panel, nudged in by 4px (`margin-inline-start: 4px`), with no rule under them.
   - Rows inside a panel are divided by inset `0.5px solid var(--separator)` hairlines (form rows start at 18px; list rows with a leading icon start where the text starts, at 66px or 78px).
   - **No panel inside a panel:** a `.list-group` nested in a `.form-card` drops to a `fill-2` fill, a transparent border, `radius-sm` corners and no shadow.
   - The side reading guide (`.deploy-guide`) stays on the canvas, set off by a 0.5px `separator-strong` rule on its left.
   - Separate cards and floating panels (the Quick Deploy core tiles, the login card, the migration panel, native dialogs, the task drawer) keep `surface` with `card-shadow`.

3. **Top: navigation and floating layers (glass).**
   - The sidebar, the toolbar capsule groups, pop-up menus, popovers, the floating action bar (`.action-bar`) and the phone tab bar are glass: `material`, `material-thick` or `menu-bg`, with `backdrop-filter: blur(24–40px) saturate(180%)` and the `glass-edge` hairline.
   - The toolbar has no full-width bar of its own. The title capsule that appears once the page scrolls and the button group on the right float separately; when content scrolls under them, `.topbar::before` adds a light blur that fades out downward, never a hard bottom line.
   - At ≤768px only the bottom tab bar keeps its blur. The toolbar capsules, the sidebar drawer and the floating action bar drop `backdrop-filter` for the near-opaque `material-flat`; the toolbar scroll edge fades from `bg` at 94%; the task drawer uses `sheet-bg` without blur, and dialogs switch to the solid `sheet-bg-solid`, because stacked blur layers make phone GPUs drop frames. Transient menus and popovers keep their blur.
   - The sidebar uses `sidebar-bg` (in light, a translucent grey a shade darker than the content area). The current page is marked with a `select-fill` grey and `label` text and icon, as in the Finder sidebar.
   - The rule: never glass on content, never a solid navigation layer.

### Color

- Appearance is `data-appearance="light|dark"` on `<html>` (Auto resolves to one of the two); the dark values live under `:root[data-appearance='dark']`.
- Text: `label` (primary), `label-2` (secondary, descriptions, field labels), `label-3` (placeholders, chevrons and separators only; under 4.5:1, never body text).
- Fills: `fill-2` (hover, nested lists, secondary fills), `fill` (segmented tracks, badges, chips), `fill-strong` (spinner track). Ordinary buttons and inputs follow macOS: white (`control-bg`, `input-bg`; translucent white in dark) with a hairline (`control-edge` on buttons, `field-edge` on inputs). A focused input turns `surface` with a 1px `accent` outline and a 3px `focus-soft` glow. The hairlines are written as zero-specificity `:where()` rules, so focus and error outlines always win.
- **The accent is a fixed clay orange**, not a user setting: fill `#bc4f1f` and text `#a94617` in light, fill `#c2541f` and text `#ff9a6b` in dark, with white `on-accent` on the fill in both. It is used the way macOS uses its accent: the primary action, controls that are on or checked (switches, checkboxes, the selected core tile and appearance option), focus, progress bars, and the highlighted item in menus and selects. The selected navigation item, links, icons and badges stay neutral. Components refer only to `accent` (fills), `accent-text` (colored text; today only `btn-tinted` and the check mark of the selected language) and `on-accent`; never write the hex values in a component. `accent-soft` (13%), `focus-ring` (45%, the keyboard focus ring) and `focus-soft` (22%, the input glow) are derived with `color-mix`; `console-focus` is the accent mixed with 35% white and stays at 6.7:1 or above on the dark console.
- **Semantic color comes in two sets.** `c-green`, `c-blue`, `c-yellow`, `c-red`, `c-gray` are for icons and 11–16% tints only. Text uses `ok`, `warn` and `danger`, which stay at 4.5:1 or above on their own tint over `bg` or `surface`, the worst case. A solid destructive button is `danger-fill` with white text; in dark it is one step deeper than `c-red` and never the same token as `danger`.
- Status mapping (traffic lights): Running → green; Starting, Stopping, Needs Migration, queued tasks and every kind of warning → amber (`c-yellow` with `warn` text); Crashed and Failed → red; Stopped → gray. Warnings never use orange: orange means only "act here". A status always carries its word, never color alone.
- **The console is always dark** in both appearances: `#161618` window, `#1f1f22` bars, `#e5e5ea` text, `#aeaeb2` muted, `#30d158` prompt. Its focus rings use `console-focus`.
- The brand gradient appears only on the brand mark `BrandMark` (145° `#ff73b0` → `#c64fd6` at 52% → `#7a4df0`) and is the only gradient in the interface. Each server core icon (`.core-paper`, `.core-fabric`, …) uses one solid `--core` color, with no gradient or colored shadow; the white glyph stays at 3:1 or above. The user avatar and the This Machine icon are solid gray.

### Type

- System font stack in `--font`, no web fonts. `:root:lang(zh-TW)` puts the Traditional Chinese fonts before the Simplified ones. Monospace is `--mono`.
- Body is 15px / 1.47 with -0.005em tracking; titles tighten to -0.015 to -0.026em.
- **Font sizes come only from the eight `--text-*` steps in `:root`**, chosen by role; never write a stray px size or a half-pixel step in a component:

  | Token | Size | Used for |
  |---|---|---|
  | `text-large` | 30px | The one large title per page, the instance name, the login title |
  | `text-title` | 22px | Section titles, the overview status sentence, the task drawer title; the instance name at ≤768px |
  | `text-headline` | 17px | Dialog and empty-state titles, overview server names, `.btn-lg` |
  | `text-input` | 16px | Text inputs on touch screens and the login fields (stops iOS zooming on focus; not a visual step) |
  | `text-body` | 15px | Body, buttons, nav items, menu items, list titles, inputs, instance tabs |
  | `text-small` | 13px | Field labels (semibold), help and descriptions, status pills, chips, `.btn-sm`, metadata; instance tabs at ≤480px |
  | `text-footnote` | 12px | Code, paths, timestamps, fine print, count and source badges |
  | `text-micro` | 11px | Tab bar labels and toolbar badges only |

  Sizes that sit next to each other differ by weight or color as well (a field label is 13px semibold `label-2`, its help 13px regular `label-2`).
- Every list of numbers, sizes, progress and times uses `font-variant-numeric: tabular-nums`.
- On touch screens (`pointer: coarse`) and at ≤768px every text input, select and textarea is at least 16px.
- JVM arguments, paths, commands and file contents use `--mono` at 13px / 1.55.

### Corners, control geometry and spacing

- **Concentric corners**, larger outside and smaller inside: `radius-xl` 22px (sidebar, dialogs) > `radius-lg` 18px (separate cards, the floating action bar) > `radius-md` 14px (content panels, lists, callouts, menus) > `radius-sm` 10px (inputs, ordinary buttons, the segmented control's tray, the instance tab tray) > `radius-xs` 7px (`.btn-sm`, chips, console tools, segmented items, the selected instance tab).
- **Interactive controls have square corners; passive indicators keep pills.**
  - `.btn`, `.btn-icon`, `.segmented` and `.hub-tabs` use `radius-sm` (10px); `.btn-sm`, `.chip`, `.console-tool`, `.segmented-item` and `.hub-tab` use `radius-xs` (7px).
  - Status pills (`.status-pill`, `.environment-status`), count and source badges (`.count-badge`, `.toolbar-badge`, `.backup-source`), switches (`.switch`), progress bars (`.progress`, `.meter`) and the floating glass capsules in the toolbar (`.toolbar-title`, `.toolbar-group`, `.toolbar-button`, `.tab-bar`) keep `radius-pill` (999px), so the shape alone tells what you can click from what only shows state.
- Control heights: buttons 34px (`.btn-sm` 28px, `.btn-lg` 46px); inputs at least 38px.
- **Touch targets (`pointer: coarse`) are at least 44×44px.** Buttons, icon buttons, toolbar buttons, segmented items, menu items, nav items, tabs, chips, disclosure summaries and inputs grow to 44px; `.btn-sm`, `.link-button` and `.back-link` keep their look and extend an invisible `::after` hit area to 44px. Desktop density does not change.
- Skeleton: 24px between page blocks (`--page-gap`), 20px on the instance page (`--instance-page-gap`), 10px inside a form group (`--form-section-gap`), 16px in grids, 14px under section titles, 18px 20px panel padding (list rows 12px 18px), 40px side margins on desktop (28px at ≤1024px, 16px at ≤768px), 1240px maximum content width, 256px sidebar, 60px toolbar.
- Short desktop tier: when the viewport is under 820px tall and at least 1025px wide (laptops at high scaling), `:root` tightens the toolbar to 56px, the page gap to 18px, the instance page gap to 14px and the form group gap to 8px, and drops the extra top gap. The large title stays 30px.

### Shadows

- Content panels use the light `panel-shadow` with a 1px `panel-border`; separate cards (core tiles, login, migration panel) use `card-shadow`; floating elements use `float-shadow`; dialogs and the task drawer use `sheet-shadow`. Core tiles do not lift or deepen their shadow on hover; they only take `hover-overlay`.

### Interaction and motion

- Hover lays `hover-overlay` over the background; press lays `active-overlay` and scales to 0.97. Disabled is 0.42 opacity with a not-allowed cursor.
- Focus: `:focus-visible` draws a 3px `focus-ring` outline offset by 2px; inputs use the glow instead.
- `--ease` (0.15s) for most transitions, `--ease-spring` (0.16–0.38s) for dialogs, drawers and switch knobs.
- Only states that are still changing loop: the Starting and Stopping status dots and the connecting console dot breathe in opacity. Running is a steady state and its dot stays still. Loading spinners rotate.
- `prefers-reduced-motion` turns off entrances, the blinking status dots and transitions; loading spinners stay.

### Responsive

- The overview server list uses a container query (`@container servers`): at 820px or narrower each row stacks as icon and name, then state, then actions; at 520px or narrower the row actions share the row equally.
- Long forms go two columns through a `.page` container query at 900px or wider (`.form-columns`, `.config-groups`) and stack in DOM order when narrower. The five Quick Deploy core tiles share one row once the form column is 640px wide; narrower, they stay 3+2, never 4+1.
- Multiplayer reuses the Quick Deploy two-column layout (`deploy-layout` + `deploy-guide`). The main column follows the task (the `OpenSwitch`, then the ordered `JoinSteps`, then advanced settings in a disclosure); the guide column holds only troubleshooting and explanations. Anything that makes joining fail if skipped stays in the main column beside the control it concerns. The guide can be closed (`is-guide-closed`), and the choice lives in `localStorage`.
- Native `<select>` options get an opaque `surface-raised` background and `label` text, so the Windows dark-mode popup does not inherit the translucent `input-bg` and turn light grey with white text.
- ≤1024px: the sidebar becomes a drawer under the toolbar and toolbar buttons hide their labels; the instance header shows a "‹ Instances" back link; once scrolled, the toolbar title capsule shows the instance name.
- ≤768px: a glass tab bar appears at the bottom, dialogs become bottom sheets and buttons fill the row; the import-mode switch drops its icons; the Download and Restore buttons in backup rows move into the `⋯` menu.
- ≤560px: the scheduled backup bar's Change Schedule button and switch drop onto an aligned second row; the host strip becomes one column.
- ≤480px: page-header and instance actions share the row equally; the instance tabs drop their icons and go down to `text-small`, so the five English tabs still fit on one line at 375px.

### Accessibility notes

Text pairs built from `label`, `label-2`, `ok`, `warn`, `danger`, `accent-text` and `on-accent` reach 4.5:1 in both appearances, including on their 11–16% tints over `bg` or `surface`. White on the orange fill is 4.9:1 in light and 4.6:1 in dark; `accent-text` is 5.4:1 / 8.0:1 on `bg` and at least 4.5:1 / 6.1:1 on its 13% tint. With the graphite dark panels, red text on a red tint is the tightest pair, at 4.8:1. When you change any color token, recheck every tinted case (status pills, `btn-ok`, `btn-danger`, `btn-tinted`, callouts), not only text on `surface`.

These pairs fall below 4.5:1; do not widen their use: `label-3` as placeholder text (about 3.3:1 on white inputs and on `surface` in light; about 2.4:1 on inputs and 2.8:1 on `surface` in dark) and white task icons on `c-green` (about 2.0–2.2:1). The queued task icon on amber uses a dark glyph (8:1 or above), not white.

## Iconography

- [Lucide](https://lucide.dev) via `lucide-react`: line icons with a 2px stroke and round caps, colored by `currentColor`. No other icon sets, no emoji.
- Sizes: navigation 17px, buttons 14–16px, menus 16px, file and backup rows 18–20px, empty states 28–30px, drop zone 28px.
- Navigation and menu icons use `label-2`; the selected navigation item's icon and text use `label` on a `select-fill` grey. The round icons of empty states, first-run choices and the drop zone are `label-2` on `fill`, never the accent.
- The brand mark is `BrandMark` ([`components/BrandMark.tsx`](../apps/web/src/components/BrandMark.tsx)) at 24, 32 and 84px. When the name is needed, set it beside the mark in `.brand-title`.

## Components

Every class is defined in `apps/web/src/styles.css`; the React components named in brackets wrap them.

| Component | Classes | Rules and notes |
|---|---|---|
| Button | `btn` + `btn-primary` / `btn-tinted` / `btn-plain` / `btn-ok` / `btn-danger` / `btn-destructive`; sizes `btn-sm`, `btn-lg`, `btn-icon`, `btn-block`; `link-button` | Square corners (`radius-sm`; `.btn-sm` uses `radius-xs`). The default button is white with a `--btn-edge` hairline, like a macOS push button; tinted variants and `btn-plain` drop the edge, and an in-row button given a transparent fill must also set `--btn-edge: none`. One `btn-primary` per view; `btn-plain` uses `label`; `btn-destructive` only for irreversible confirmations. `link` and `link-button` use the body text color with an underline, not the accent |
| Chip | `chip`, `chip-mono`, `chip-desc` in `quick-cmd-bar` and `jvm-memory-tiers` | Small square corners (`radius-xs`), for console quick commands, memory presets and the like. A selected preset lifts to white with a hairline edge, like the thumb of a segmented control; it is not tinted |
| Segmented control | `segmented`, `segmented-item` (`active`) | A square-cornered tray (10px outside, 7px thumb) for sibling views of the same content (filters, import method, multiplayer method) |
| Instance tabs | `hub-tabs`, `hub-tab` (`active`) | A compact recessed tray (`fill`, `radius-sm`); the current tab lifts as a solid `surface-raised` block (`radius-xs`) with `label` icon and text. No full-width rule and no underline; scrolls sideways when it does not fit |
| Toolbar group | `toolbar-group`, `toolbar-button`, `toolbar-badge` | Floating glass capsules; labels hide at ≤1024px |
| Toolbar title | `toolbar-title` | A 42px glass capsule that appears once the page scrolls |
| Sidebar | `sidebar`, `sidebar-brand`, `nav-section`, `nav-item` (`active`), `sidebar-footer`, `sidebar-settings` (`active`) | A drawer at ≤1024px. Navigation is one list with no groups or group titles; the current page is a `select-fill` grey, not the accent. The footer keeps the user name and two icon buttons, the Panel Settings gear and Sign Out, so an English user name still fits |
| Settings section | `settings-page`, `settings-section`, `settings-section-head`, `settings-section-body` | Panel Settings only. At 820px or wider a 200px column on the left holds the group name and who it affects, and an inset panel up to 720px wide on the right holds the rows; narrower, they stack [`SettingsPage`] |
| Settings row | `settings-row`, `settings-row-notes`, `settings-row-select`, `settings-load-error`, `settings-info`, `settings-path`, `settings-path-row` | Panel Settings only: the name and its notes on the left, one control on the right that applies at once (no save bar). Rows with notes on several lines add `settings-row`, which aligns the control to the top; read-only addresses and paths sit in a `dl` in monospace and select in one click [`SettingsPage`, `SessionDurationRow`, `DownloadSourceRow`] |
| Breadcrumbs | `breadcrumbs`, `breadcrumb-item`, `breadcrumb`, `breadcrumb-sep` | The current level has `aria-current="page"` |
| Field | `field`, `field-help`, `field-warn`, `error`, `input`, `input-row`, `grid grid-2` | White inputs with a hairline edge (`input-bg` + `field-edge`). A value that fails a check gets `aria-invalid`: the hairline turns into a red outline and an `error` line appears under it. Build fields with `Field` or `useFieldFeedback` (the error appears once the field has lost focus or the form asked every field to show its error, then follows every keystroke). Numbers always use `NumberInput` (never `type="number"`), passwords `PasswordInput`, and a unit or button inside the box uses `input-affix` with `--affix-space` |
| Switch / checkbox | `switch` (`role="switch"`), `checkbox-field` | A switch on its own saves at once; a checkbox is submitted with its form. In a settings list with a save bar (`server.properties`), switches are saved with the bar |
| Panels and sections | `card`, `form-card`, `page-section`, `section-header`, `section-title`, `count-badge`, `form-section-title`, `step-badge` | Keep writing `card form-card` for a form group: it renders as an inset solid panel (`surface` + 1px `panel-border` + `radius-md`) with its title outside, above it; a `.list-group` nested inside drops to `fill-2`. No glass, no colored side stripes. `step-badge` is `label-2` on `fill`, only for steps that really are a sequence |
| Grouped list | `list-group`, `list-row`, `list-row-text`, `list-row-title`, `list-row-desc`, `list-row-control`, `list-row-value` | An inset solid panel (`surface` + 1px `panel-border` + `radius-md`); rows have 12px 18px padding, and hairlines start 18px in |
| Disclosure | `details.disclosure` | Advanced options only |
| Imports source list | `import-dir-row`, `import-dir-path`, `import-source-head`, `import-source-list list-group`, `import-source-option list-row` (`is-unavailable`), `import-source-reason` | Copy from imports only: the folder's path as a copyable value, then a whole-row radio list of candidate folders; a folder that can't be imported is disabled and gives the reason in `warn` [`ImportsSourceSection`] |
| Detected summary | `import-summary`, `import-summary-row`, `import-summary-note`, `import-summary-warn` | Import Settings only: a two-column summary of the server, Java and memory the panel recognized. The controls behind it sit in a `disclosure` that opens by itself when one of them needs attention |
| QR code | `qr-code` inside `remote-qr` | Black on white with a quiet zone in both appearances; drawn as inline SVG by `QrCode.tsx` |
| Copyable value | `direct-address`, `direct-command`, `remote-url`, `remote-join-value` | Monospace with `user-select: all`; copy with `copyText()` from `clipboard.ts` |
| Action bar and save bar | `action-bar`, `action-bar-status`, `action-bar-check`, `save-bar`, `save-bar-slot` | At most one per page, floating at the bottom. Pages that edit existing settings (instance settings, server.properties) use `SaveBar`: hidden until something changed, then the number of unsaved changes with Discard and Save, and after saving on a running instance a note to restart with a Restart button. Create flows (Quick Deploy, Import) show the bar all the time, and it may hold one required consent, such as the EULA |
| Callout | `callout` + `callout-info` / `callout-success` / `callout-warning` / `callout-danger`, `callout-icon` | `callout-info` and a callout without a modifier are neutral gray; warnings are amber. Keep it to what is wrong and the next step. A requirement that stays until it is met (such as administrator rights on Windows) is a list row with a status pill and a button, not a callout; an action with consequences opens a `ConfirmDialog` that holds them. The body is `label`; only `<strong>` turns `danger` |
| Ready strip | `ready-strip`, `ready-strip-icon`, `ready-strip-text` | One line above the console once the server is ready: green only on the icon and a 9% tint, with an invite button and a dismiss button [`ReadyHint`] |
| Status pill | `status-pill` + `running` / `stopped` / `starting` / `stopping` / `crashed` / `warning`, `status-dot` | Keeps `radius-pill`: a dot and the status word [`StatusPill`, `InstanceStatusPill`] |
| Progress and loading | `progress`, `progress-fill`, `task-progress`, `spinner`, `spinner-sm`, `page-loading` | Background tasks stay visible until Completed or Failed |
| Empty state | `empty-state`, `empty-icon`, `empty-actions`, `empty-state-compact` | Title + next step + primary button, on the same inset solid panel |
| Task card | `task-card status-<status>`, `task-card-head`, `task-card-icon`, `task-card-message`, `task-card-error`, `task-card-foot` | Inside the `task-drawer` [`TaskCenter`]. `status-cancelled` is neutral gray, never red; the toolbar badge counts tasks in progress only |
| Meter | `meter` (`is-neutral` / `is-warning`), `meter-fill` | A 4px decorative usage bar; the number always sits beside it [`Meter`] |
| Host strip | `host-strip`, `host-meters`, `host-meter`, `metrics-status` | This machine's CPU, memory and data disk, directly on the canvas with no panel, so it weighs less than the server list; at ≤768px it moves below the list [`HostMeters`] |
| Server list | `server-section`, `server-list`, `server-row`, `server-id`, `server-state`, `server-sentence` (`is-warn` / `is-danger`), `server-figures`, `server-actions`, `server-next-quiet` | An inset solid panel whose rows line up through `subgrid`. The whole row opens the instance, and instances that need attention come first. The list has no visible heading: the page title and the status sentence introduce it. A status pill is followed by a sentence only when it adds something the pill does not say (why the server cannot start, that the world is still loading), with the matching button first in the row; row hairlines start at the name column. On wide rows Start, Stop, More and Invite Players (`server-next-quiet`) have no fill until hovered; only a button that fixes a problem keeps a light fill |
| Overview status | `overview-status`, `overview-status-issues` | The 22px subtitle sentence ("6 instances, 2 running"), followed in `danger` by the number of instances that need attention |
| Start paths | `start-paths`, `start-path-list`, `start-path` | The empty overview's three ways to add a server, in the same inset solid panel, each a full-row link |
| File list | `files-toolbar`, `file-list list-group`, `file-row`, `file-main`, `file-icon is-dir|is-file` | An inset solid panel; dividers start at the file name column [`FilesTab`] |
| Backups tab | `backups-toolbar`, `backups-schedule`, `backups-list-section`, `backup-list list-group`, `backup-row`, `backup-source`, `backup-actions` | The toolbar carries no explanation while the server is stopped, and only a "Stop server to restore" status tag while it runs. Below it sits the one-line scheduled backup bar (a normal run takes no second line; only a failed one opens a `callout-danger`), then the backup list panel with a count badge and the total size. Each row tags where its backup came from; on desktop Download and Restore sit in the row, and at ≤768px they move into the `⋯` menu [`BackupsTab`, `BackupScheduleSection`] |
| Brand mark / core icon | `brand-mark brand-mark-<size>`, `core-icon core-<type>` | [`BrandMark`, `CoreIcon`] |
| Menu | `action-menu-trigger`, `action-menu-panel`, `menu-item` (`is-danger`) | Portaled to `<body>` with fixed coordinates, so a container's `overflow: hidden` cannot clip it [`ActionMenu`] |
| Dialog | `confirm-dialog`, `confirm-dialog-panel`, `confirm-dialog-title` / `-body` / `-footer` | Native `<dialog>`; a bottom sheet at ≤768px [`ConfirmDialog`] |
| Popovers | `popover`, `appearance-*`, `accent-*`, `language-options` | [`ThemeToggle`, `LanguageToggle`] |
| Console | `console-window`, `console-header-bar`, `console-status`, `console-tool`, `console-output`, `console-input-bar` | Always dark. At ≤768px the output leaves room for the command input and the tab bar; recheck at 390×844 whenever the instance header or tabs change height [`ConsolePanel`] |
| Drop zone | `drop-zone` (`is-dragging`, `has-file`, `is-disabled`) | Inside a `field` |

## Building a page

1. Page skeleton: `.page` holds a `.page-header` (via `PageHeader`: large title, subtitle, actions on the right) followed by `.page-section` blocks. Form pages put the main action in an `.action-bar` or a `SaveBar` and wrap the fields in a `<form>`: the main button is `type="submit"`, every other button states `type="button"`.
2. Reuse the classes above first; new values that repeat go into the `:root` and dark blocks of `styles.css`.
3. Write every string into the three locale tables, then check light and dark, all three languages and a 375px width, including the loading, empty, error and disabled states and keyboard focus.
4. Run the template check below on real screenshots, not only on the code.
5. Primary buttons stay disabled until the input passes validation (shared helpers in `apps/web/src/validation.ts`; the server still checks on its own). Do not flag an empty field before the user has typed, and do not interrupt the first time they type in a field. Set the busy state on the click itself, so a double click cannot submit twice.

## Template check

A style or a piece of copy is a template move when you would carry it into any other product unchanged. Before shipping a page, go through the list and keep a choice only when you can say what it tells the user:

- **Structure:** do not chop data into standalone stat cards to fill a row; no bordered panel inside a panel of the same level; no `01 / 02 / 03` numbering on things that are not steps; a state that one sentence can say is not split into a big number and a small label; no decorative gradients.
- **Type:** no single word set apart in italic or color in a heading; no ALL-CAPS or widely tracked labels; no small line above a heading that repeats it; sizes only from the eight tokens; monospace only for logs, commands, code and paths.
- **Chrome:** middle dots (`A · B`) go only between **metadata of the same kind** (size, time, count, version, path), never to join a label and its state or a figure and a remark; no decorative `→` after button or link text (an arrow that shows a click path stays).
- **Color:** the orange accent is only for the primary action, controls that are on or checked, focus and progress, never decoration; orange is never a status or a warning; no hues that are not tokens.
- **Motion:** no entrance on every section and no hover movement on plain rows that cannot be clicked; motion answers a real action and respects `prefers-reduced-motion`.
- **Copy:** no marketing filler and no standing explanation at the top of a page; errors do not apologize and give the cause and the way out; one action keeps one name through a flow.

Spend boldness in one place per page, keep the rest quiet, and remove one thing before you finish.
