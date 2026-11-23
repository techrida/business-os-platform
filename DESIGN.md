---
name: Business OS Workspace
description: Light-first operational design system for the Business OS staff workspace, grounded in Outfit Variable typography, crisp neutral surfaces, cobalt primary actions, and contrast-verified control borders.
colors:
  primary: '#2563eb'
  primaryHover: '#1d4ed8'
  primaryActive: '#1e40af'
  primarySubtle: '#eff6ff'
  accentVibrant: '#0a99ff'
  background: '#ffffff'
  surfaceSubtle: '#f8fafc'
  surfaceMuted: '#f1f5f9'
  borderSubtle: '#e2e8f0'
  borderStrong: '#cbd5e1'
  controlBorder: '#64748b'
  controlBorderHover: '#334155'
  textPrimary: '#0f172a'
  textSecondary: '#475569'
  textTertiary: '#64748b'
  textDisabled: '#94a3b8'
  successText: '#15803d'
  successSurface: '#f0fdf4'
  warningText: '#b45309'
  warningSurface: '#fffbeb'
  errorText: '#b91c1c'
  errorAction: '#dc2626'
  errorSurface: '#fef2f2'
  infoText: '#2563eb'
  infoSurface: '#eff6ff'
typography:
  displayFont: 'Outfit Variable, Outfit, ui-sans-serif, system-ui, sans-serif'
  bodyFont: 'Outfit Variable, Outfit, ui-sans-serif, system-ui, sans-serif'
  monoFont: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  display:
    size: 40px
    lineHeight: 48px
    weight: 700
    letterSpacing: -0.02em
  h1:
    size: 32px
    lineHeight: 40px
    weight: 600
    letterSpacing: -0.02em
  h2:
    size: 24px
    lineHeight: 32px
    weight: 600
    letterSpacing: -0.02em
  h3:
    size: 20px
    lineHeight: 28px
    weight: 600
    letterSpacing: 0
  bodyLarge:
    size: 18px
    lineHeight: 26px
    weight: 400
    letterSpacing: 0
  body:
    size: 16px
    lineHeight: 24px
    weight: 400
    letterSpacing: 0
  bodySmall:
    size: 14px
    lineHeight: 20px
    weight: 400
    letterSpacing: 0
  caption:
    size: 12px
    lineHeight: 16px
    weight: 500
    letterSpacing: 0.01em
rounded:
  xs: 4px
  md: 6px
  lg: 8px
  status: 10px
  xl: 12px
  2xl: 24px
  full: 9999px
spacing:
  contentGap: 16px
  page: 24px
  section: 32px
  sectionLarge: 48px
components:
  primaryButton:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.background}'
    typography: '{typography.bodySmall}'
    rounded: '{rounded.lg}'
    padding: '0 16px'
    height: '40px'
  secondaryButton:
    backgroundColor: '{colors.background}'
    textColor: '{colors.primary}'
    typography: '{typography.bodySmall}'
    rounded: '{rounded.lg}'
    padding: '0 16px'
    height: '40px'
  inputField:
    backgroundColor: '{colors.background}'
    textColor: '{colors.textPrimary}'
    typography: '{typography.bodySmall}'
    rounded: '{rounded.lg}'
    padding: '10px 12px'
    height: '42px'
  card:
    backgroundColor: '{colors.background}'
    textColor: '{colors.textPrimary}'
    rounded: '{rounded.xl}'
    padding: '24px'
  statusBadge:
    backgroundColor: '{colors.infoSurface}'
    textColor: '{colors.infoText}'
    typography: '{typography.caption}'
    rounded: '{rounded.status}'
    padding: '4px 8px'
  dropdownPanel:
    backgroundColor: '{colors.background}'
    textColor: '{colors.textPrimary}'
    typography: '{typography.bodySmall}'
    rounded: '{rounded.lg}'
    padding: '8px'
  dialog:
    backgroundColor: '{colors.background}'
    textColor: '{colors.textPrimary}'
    rounded: '{rounded.xl}'
    padding: '20px 24px'
    width: '560px'
  toast:
    backgroundColor: '{colors.background}'
    textColor: '{colors.textPrimary}'
    typography: '{typography.bodySmall}'
    rounded: '{rounded.xl}'
    padding: '12px'
    width: '380px'
---

## Overview

**Creative North Star: "Quiet Ledger Precision"**

Business Operating System (Business OS) is a multi-module staff workspace covering Customer Relationship Management (CRM), sales, procurement, payables, document verification, and workspace administration. This document records the User Interface (UI) design system actually built in `apps/workspace` today, with source file citations for every token, primitive, and page pattern, alongside neutral `Figma vs app` notes wherever the Figma specification and the running application diverge.

The interface favours legible tables, crisp white cards on subtle slate grounds, high-contrast form boundaries, and a single cobalt primary action colour (`#2563eb`). Decorative chrome stays out of the way: light mode is currently pinned at the document root, status labels stay to one or two words, interactive controls carry explicit hover and keyboard focus states, and accessible third-party primitives (React Aria, Radix UI, Sonner, and TipTap) back every complex widget rather than hand-rolled overlays.

**Key Characteristics:**

- **Light mode pinned, dark stylesheet unused:** `packages/locale/src/theme-mode.ts` sets `BOS_LIGHT_ONLY = true`, pinning `data-theme="light"` on `<html>`. Dark-mode Cascading Style Sheets (CSS) alias overrides exist in `tokens.css` and `token-overrides.css`, but they apply only where `data-theme="dark"` is set, and no code sets it.
- **Two-layer token architecture:** Generated Figma token exports live in `apps/workspace/src/styles/tokens.css`, followed by deliberate Web Content Accessibility Guidelines (WCAG) contrast and toast surface overrides in `apps/workspace/src/styles/token-overrides.css`.
- **Single-font geometric clarity:** Self-hosted `Outfit Variable` handles all display, heading, body, and table copy, paired with a system monospace stack for document numbers, Permanent Account Number (PAN) values, and identifiers.
- **Instant, URL-backed workflows:** List screens filter via Uniform Resource Locator (URL) query parameters and debounced search without an Apply button, confirmations open modal dialogs rather than expanding inline, and short-lived feedback reports through a top-right toast stack.

## Colors

Stylesheets load in strict order inside `apps/workspace/src/app/layout.tsx`:

1. `apps/workspace/src/styles/tokens.css` (primitives, light semantic and component aliases, activity tokens, responsive typography and spacing, and dark-mode semantic aliases).
2. `apps/workspace/src/styles/token-overrides.css` (control border contrast overrides and neutral toast surface tokens, plus their dark-mode counterparts).
3. `@fontsource-variable/outfit` (self-hosted variable font faces).
4. `apps/workspace/src/styles/globals.css` (font family override to `'Outfit Variable'`, focus-ring custom properties, shell dimensions, reset, and reduced-motion rules).

### Theme Mode (Light Current, Dark Stylesheet Not Wired)

`packages/locale/src/theme-mode.ts` exports `BOS_LIGHT_ONLY = true`. Both `apps/workspace/src/app/layout.tsx` and `apps/portal/src/app/layout.tsx` write `data-theme={BOS_LIGHT_ONLY ? 'light' : undefined}` onto `<html>`. Because `BOS_LIGHT_ONLY` is `true`, the running application renders exclusively in light mode today and exposes no theme switcher.

Dark mode is not one flag away. Both `apps/workspace/src/styles/tokens.css` (lines 476 to 540) and `apps/workspace/src/styles/token-overrides.css` (lines 31 to 41) scope dark aliases to `:root[data-theme='dark'], :root:not([data-theme='light']) [data-theme='dark']`; `tokens.css` also declares `color-scheme: dark` there. Both selectors need an element with `data-theme="dark"`. Setting `BOS_LIGHT_ONLY` to `false` only removes the attribute from `<html>`, so the light values still apply; nothing in `apps/` or `packages/` sets `data-theme="dark"`. Primitives (`--brand-*`, `--neutral-*`, `--success-*`, `--warning-*`, `--error-*`, `--info-*`) are defined once in `:root` and never redefined in dark mode; only semantic and component aliases remap.

| Semantic Token                                                      | Light Value (Current)       | Dark Value (needs `data-theme="dark"`)            | Source                                                   |
| ------------------------------------------------------------------- | --------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `--surface-default`                                                 | `#ffffff` (`--neutral-0`)   | `#020617` (`--neutral-950`)                       | `tokens.css:128, 510`                                    |
| `--surface-subtle`                                                  | `#f8fafc` (`--neutral-50`)  | `#0f172a` (`--neutral-900`)                       | `tokens.css:132, 514`                                    |
| `--surface-muted`                                                   | `#f1f5f9` (`--neutral-100`) | `#1e293b` (`--neutral-800`)                       | `tokens.css:131, 513`                                    |
| `--surface-elevated`                                                | `#ffffff` (`--neutral-0`)   | `#1e293b` (`--neutral-800`)                       | `tokens.css:129, 511`                                    |
| `--text-primary`                                                    | `#0f172a` (`--neutral-900`) | `#f8fafc` (`--neutral-50`)                        | `tokens.css:137, 518`                                    |
| `--text-secondary`                                                  | `#475569` (`--neutral-600`) | `#94a3b8` (`--neutral-400`)                       | `tokens.css:138, 519`                                    |
| `--text-tertiary`                                                   | `#64748b` (`--neutral-500`) | Not overridden: stays `#64748b` (`--neutral-500`) | `tokens.css:139` (no dark rule)                          |
| `--border-default`                                                  | `#e2e8f0` (`--neutral-200`) | `#334155` (`--neutral-700`)                       | `tokens.css:97, 486`                                     |
| `--border-strong`                                                   | `#cbd5e1` (`--neutral-300`) | `#475569` (`--neutral-600`)                       | `tokens.css:99, 488`                                     |
| `--action-primary`                                                  | `#2563eb` (`--brand-600`)   | `#60a5fa` (`--brand-400`)                         | `tokens.css:92, 482`                                     |
| `--action-primary-hover`                                            | `#1d4ed8` (`--brand-700`)   | `#93c5fd` (`--brand-300`)                         | `tokens.css:94, 484`                                     |
| `--action-primary-active`                                           | `#1e40af` (`--brand-800`)   | `#bfdbfe` (`--brand-200`)                         | `tokens.css:93, 483`                                     |
| `--input-border` (and select, search, checkbox, radio, date-picker) | `#64748b` (`--neutral-500`) | `#94a3b8` (`--neutral-400`)                       | `token-overrides.css:14, 16-17, 19-21; 33, 35-36, 38-40` |
| `--input-hover-border`, `--select-hover-border`                     | `#334155` (`--neutral-700`) | `#e2e8f0` (`--neutral-200`)                       | `token-overrides.css:15, 18; 34, 37`                     |
| `--focus-ring` / `--focus-ring-offset`                              | `#3b82f6` / `#ffffff`       | `#60a5fa` / `#020617`                             | `tokens.css:102-103, 490-491`                            |

**Figma vs app:** Figma variable exports expose light mode only with no dark variable mode. The app pins light mode via `BOS_LIGHT_ONLY = true`; its dark-mode semantic and component overrides in `tokens.css` and `token-overrides.css` apply only under `data-theme="dark"`, which nothing sets.

### Primary & Accent Palette

All brand steps come from `apps/workspace/src/styles/tokens.css` (lines 21 to 30 and 187). The `--info-*` primitive scale (lines 78 to 87) duplicates `--brand-*` identically.

| Token                   | Name            | Hex       | Role                                                                                                             | Source           |
| ----------------------- | --------------- | --------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| `--brand-50`            | Ice Tint        | `#eff6ff` | Subtle action fills, selected option and active tab background (`--interactive-selected`), info badge background | `tokens.css:21`  |
| `--brand-100`           | Mist Blue       | `#dbeafe` | Hover tint on a selected dropdown option                                                                         | `tokens.css:22`  |
| `--brand-200`           | Powder Blue     | `#bfdbfe` | Dark-mode `--action-primary-active`                                                                              | `tokens.css:23`  |
| `--brand-300`           | Sky Blue        | `#93c5fd` | Dark-mode primary hover                                                                                          | `tokens.css:24`  |
| `--brand-400`           | Cerulean        | `#60a5fa` | Dark-mode primary fill and focus ring                                                                            | `tokens.css:25`  |
| `--brand-500`           | Azure           | `#3b82f6` | Light-mode `--focus-ring` and `--input-focus-border`                                                             | `tokens.css:26`  |
| `--brand-600`           | Cobalt Primary  | `#2563eb` | `--action-primary`, links, checked indicators, info badge and alert text (`--status-info`)                       | `tokens.css:27`  |
| `--brand-700`           | Royal Hover     | `#1d4ed8` | `--action-primary-hover`                                                                                         | `tokens.css:28`  |
| `--brand-800`           | Deep Cobalt     | `#1e40af` | `--action-primary-active`                                                                                        | `tokens.css:29`  |
| `--brand-900`           | Midnight Cobalt | `#1e3a8a` | High-contrast brand ink                                                                                          | `tokens.css:30`  |
| `--accent-vibrant-blue` | Vibrant Accent  | `#0a99ff` | Hand-added token, declared only: no stylesheet or component references it                                        | `tokens.css:187` |

### Neutral Palette

Defined in `apps/workspace/src/styles/tokens.css` (lines 32 to 43), following a cool slate ramp:

- **Pure White (`#ffffff`, `--neutral-0`):** Default card, table, dialog, and input background, and the shell's main column (`--surface-default`, `--surface-elevated`).
- **Paper Slate (`#f8fafc`, `--neutral-50`):** Subtle ground for the top header bar, drop zones, and the rich-text toolbar (`--surface-subtle`).
- **Fog Slate (`#f1f5f9`, `--neutral-100`):** `<body>` background (`globals.css:45`), disabled control backgrounds, neutral badges (`--surface-muted`), and table row and dropdown option hover (`--interactive-hover`).
- **Hairline Slate (`#e2e8f0`, `--neutral-200`):** Structural dividers, card borders, sidebar edge, and table row borders (`--border-default`, `--card-border`).
- **Rule Slate (`#cbd5e1`, `--neutral-300`):** Emphasised dividers and the dashed `ImageUpload` drop-zone border (`--border-strong`), and the disabled primary button fill (`--button-disabled-bg`).
- **Muted Slate (`#94a3b8`, `--neutral-400`):** Disabled text and disabled icons (`--text-disabled`, `--icon-disabled`).
- **Control Slate (`#64748b`, `--neutral-500`):** Tertiary text and placeholder copy (`--text-tertiary`, `--input-placeholder: var(--text-tertiary)`), and the overridden resting border for all text, select, search, checkbox, radio, and date-picker inputs (`--input-border`).
- **Body Slate (`#475569`, `--neutral-600`):** Secondary prose, table metadata, and inactive navigation icons (`--text-secondary`).
- **Hover Slate (`#334155`, `--neutral-700`):** Overridden hover border for inputs and selects (`--input-hover-border`, `--select-hover-border`).
- **Charcoal Slate (`#1e293b`, `--neutral-800`):** Light-mode `--overlay-scrim-subtle`, and dark-mode elevated and muted surfaces.
- **Ink Slate (`#0f172a`, `--neutral-900`):** Primary headings, body text, and table primary cells (`--text-primary`), and the light-mode modal scrim base (`--overlay-scrim`, `--modal-overlay`).
- **Obsidian Slate (`#020617`, `--neutral-950`):** Dark-mode scrim base (`--overlay-scrim`) and dark-mode base canvas.

### Semantic, Status & Activity Tokens

Semantic ramps (`--success-*`, `--warning-*`, `--error-*`, `--info-*`) live in `apps/workspace/src/styles/tokens.css` (lines 45 to 87), with semantic status aliases on lines 118 to 125 and activity-type tokens on lines 174 to 185 (dark overrides on lines 524 to 535).

| Family  | Surface (`-50`) | Mid Accent (`-600`) | Text Ink (`-700`) | Darkest (`-900`) | Usage                                                                        |
| ------- | --------------- | ------------------- | ----------------- | ---------------- | ---------------------------------------------------------------------------- |
| Success | `#f0fdf4`       | `#16a34a`           | `#15803d`         | `#14532d`        | Approved, won, verified, paid, saved states                                  |
| Warning | `#fffbeb`       | `#d97706`           | `#b45309`         | `#78350f`        | Pending, awaiting decision, expiring, caution                                |
| Error   | `#fef2f2`       | `#dc2626`           | `#b91c1c`         | `#7f1d1d`        | Validation errors, lost/rejected, destructive confirm button (`--error-600`) |
| Info    | `#eff6ff`       | `#2563eb`           | `#1d4ed8`         | `#1e3a8a`        | New, in progress, informational callouts                                     |

**CRM Activity Badge Tokens** (hand-added in `apps/workspace/src/styles/tokens.css:174-185`, not from Figma):

- Call: `--activity-call-bg` (`--brand-600`, `#2563eb`), `--activity-call-text`, `--activity-call-ring` (`hsl(221deg 83% 37%)`).
- Meeting: `--activity-meeting-bg` (`hsl(262deg 83% 53%)`), `--activity-meeting-text`, `--activity-meeting-ring` (`hsl(262deg 83% 37%)`).
- Email: `--activity-email-bg` (`hsl(152deg 83% 26%)`), `--activity-email-text`, `--activity-email-ring` (`hsl(152deg 83% 10%)`).
- Note: `--activity-note-bg` (`hsl(330deg 83% 44%)`), `--activity-note-text`, `--activity-note-ring` (`hsl(330deg 83% 28%)`).
- Ink: each `--activity-{call,meeting,email,note}-text` is `var(--neutral-0)` (`#ffffff`); the source comment states 5.2:1 to 6.8:1 contrast for every fill. In the dark rules, fills move to `94%` saturation and `68%` lightness (call uses `--brand-400`), rings to `hsl(<hue>deg 94% 84%)`, and each `-text` token to `--neutral-950`.

### Color Rules

**The Control Border Contrast Rule.** Every interactive input boundary (`--input-border`, `--search-border`, `--select-border`, `--checkbox-border`, `--radio-border`, `--date-picker-border`) uses `--neutral-500` (`#64748b`, roughly 4.8:1 against white) at rest and `--neutral-700` (`#334155`) on hover via `apps/workspace/src/styles/token-overrides.css` (lines 14 to 21). Hairline structural borders (`--border-default`, `#e2e8f0`) are reserved for non-interactive dividers and card outlines so form controls satisfy WCAG 2.1 Success Criterion 1.4.11 (3:1 non-text contrast).

**The 700-Step Status Ink Rule.** The `success`, `warning` (also used for `pending`), and `error` tones of `Badge` (`apps/workspace/src/components/ui/badge.module.css`) pair `-50` background tints with `-700` text primitives (`--success-700`, `--warning-700`, `--error-700`) so small 12px status labels meet WCAG AA 4.5:1 text contrast. The `info` tone keeps `--badge-info-text` (`--status-info`, `--info-600`, `#2563eb`), which the source comment measures at 4.75:1.

**The Neutral Toast Surface Rule.** Toasts never flood the card background with solid status colours. `apps/workspace/src/styles/token-overrides.css` (lines 24 to 28) sets `--toast-bg: var(--dropdown-bg)`, `--toast-border: var(--dropdown-border)`, and `--toast-text: var(--text-primary)`. Status colour appears solely on the leading icon and the 3px inline-start accent border (`apps/workspace/src/components/ui/toast.module.css`).

- **Figma vs app (Form borders):** Figma assigns `--neutral-200` (`#e2e8f0`, 1.2:1) at rest and `--neutral-300` (`#cbd5e1`) on hover to form controls. The app overrides those tokens in `token-overrides.css` to `--neutral-500` (`#64748b`) at rest and `--neutral-700` (`#334155`) on hover for WCAG 1.4.11 contrast.
- **Figma vs app (Status badge text):** Figma's status badge (`469:13451`) pairs `-50` tints with `-600` status text for Success, Pending, error, and info (`#16a34a`, `#d97706`, `#dc2626`, `#2563eb`) and has no neutral variant. The app uses `-700` text for `success`, `warning`/`pending`, and `error` in `badge.module.css`, keeps `-600` for `info`, and adds a `neutral` tone.
- **Figma vs app (Toast surface):** Figma defines solid status-filled `--toast-*-bg` tokens in `tokens.css` (lines 332 to 339) and includes no toast component on the Components page. The app overrides toasts in `token-overrides.css` and `toast.module.css` to neutral white cards with a 3px status start border and status icon.

## Typography

### Font Families

Defined in `apps/workspace/src/styles/tokens.css:373` and overridden in `apps/workspace/src/styles/globals.css:9-12`:

- **Display & Body:** `'Outfit Variable', 'Outfit', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` (loaded from `@fontsource-variable/outfit` in `apps/workspace/src/app/layout.tsx`).
- **Monospace:** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (`--font-family-mono`), used for document codes, PAN numbers, Tax Identification Numbers, and audit identifiers.

### Weights & Letter Spacing

Defined in `apps/workspace/src/styles/tokens.css:383-390`:

- Weights: `--font-weight-regular: 400`, `--font-weight-medium: 500`, `--font-weight-semibold: 600`, `--font-weight-bold: 700`.
- Letter spacing: `--letter-spacing-tight: -0.02em`, `--letter-spacing-normal: 0`, `--letter-spacing-medium: 0.01em`, `--letter-spacing-wide: 0.02em`.

### Mobile-First Responsive Type Scale

Values step up across four breakpoints in `apps/workspace/src/styles/tokens.css` (lines 375 to 472; each breakpoint redeclares only the values that change):

| Token Pair (`--font-size-*` / `--line-height-*`) | Mobile (`0px+`) | Tablet (`768px+`) | Desktop (`1024px+`) | Wide (`1440px+`) | Typical Usage                                                                                     |
| ------------------------------------------------ | --------------- | ----------------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `display`                                        | `32px / 40px`   | `36px / 44px`     | `40px / 48px`       | `48px / 56px`    | Not referenced by any stylesheet                                                                  |
| `h1`                                             | `28px / 36px`   | `30px / 38px`     | `32px / 40px`       | `36px / 44px`    | Global `h1`, `NoticeCard` title, customer, vendor, and invoice document headings                  |
| `h2`                                             | `22px / 28px`   | `24px / 30px`     | `24px / 32px`       | `28px / 36px`    | Global `h2`, `PageHeader` title (capped at `min(24px, var(--font-size-h2))` in `page.module.css`) |
| `h3`                                             | `18px / 26px`   | `20px / 28px`     | `20px / 28px`       | `22px / 30px`    | Global `h3`, section headings, `Dialog` title (capped at `min(20px, var(--font-size-h3))`)        |
| `body-large`                                     | `16px / 24px`   | `17px / 26px`     | `18px / 26px`       | `18px / 28px`    | `Panel` and `EmptyState` titles, prominent summaries                                              |
| `body`                                           | `14px / 20px`   | `15px / 24px`     | `16px / 24px`       | `16px / 24px`    | `<body>` default text                                                                             |
| `body-small`                                     | `13px / 18px`   | `14px / 20px`     | `14px / 20px`       | `14px / 20px`    | Medium and large buttons, inputs, table cells, filters, toasts, dialog descriptions               |
| `caption`                                        | `12px / 16px`   | `12px / 16px`     | `12px / 16px`       | `12px / 16px`    | Table column headers, badges, small buttons, field hints and errors, timestamps                   |

### Typography Rules

**The Coarse-Pointer 16px Floor Rule.** Inside `@media (pointer: coarse)`, text inputs, selects, comboboxes, date pickers, and rich-text editors floor `font-size` at `max(16px, var(--font-size-body-small))` (`field.module.css`, `select.module.css`, `combobox.module.css`, `date-picker.module.css`, `rich-text-editor.module.css`) so mobile browsers do not auto-zoom the viewport on focus.

**The Compact Page-Header Rule.** Inside the workspace shell, `PageHeader` (`apps/workspace/src/components/ui/page.module.css`) renders its `<h1>` at `min(24px, var(--font-size-h2))` with `font-weight: 600` and tight tracking, keeping dense operational screens from losing vertical space above tables and KPI strips.

**The Tabular Figures Rule.** Numeric columns use `<Th align="end">` and `<Td align="end">` (`table.tsx`), whose `.end` class in `table.module.css` right-aligns the cell and sets `font-variant-numeric: tabular-nums`. Key Performance Indicator (KPI) values (`stat-card.module.css`) and `CellTitle` metadata also use tabular figures. Amount grouping (Nepali or International) comes from `NumberSystemProvider` (`number-system-context.tsx`).

**Pre-existing Drift Note (Not Canonized).** Several CRM detail and procurement form screens (`apps/workspace/src/app/(app)/leads/[id]/page.tsx`, `leads.module.css`) include uppercase tracked `.eyebrow` kickers with numeric prefixes (for example, `"01 · The basics"`). This is pre-existing Figma-ported markup and is not canonized for new surfaces.

- **Figma vs app (Letter-spacing units):** Figma stores bare numbers (`0.01`, `-0.02`, shown as `px` in the inspector). The app emits `em` units (`0.01em`, `-0.02em`) in `tokens.css:387-390`.
- **Figma vs app (Composite text styles and H1 height):** Figma defines named composite text styles (including `Numeric/Large` and `Label/mini`) and binds the Dashboard `Heading/h1` to `32px / 44px`. The app exposes atomic font tokens only, uses `32px / 40px` for desktop `h1`, and caps `PageHeader` titles at `min(24px, var(--font-size-h2))`.

## Layout

### Breakpoints, Grid & Spacing Rhythm

Defined in `apps/workspace/src/styles/tokens.css` (lines 366 to 472). Each breakpoint block redeclares only the values that change; the Source column cites each declaration. Breakpoint tokens (`--breakpoint-mobile: 0px`, `--breakpoint-tablet: 768px`, `--breakpoint-desktop: 1024px`, `--breakpoint-wide: 1440px`) are documentation custom properties because CSS `@media` queries require literal values.

| Layout Token              | Mobile (`0px+`) | Tablet (`768px+`) | Desktop (`1024px+`) | Wide (`1440px+`) | Source                          |
| ------------------------- | --------------- | ----------------- | ------------------- | ---------------- | ------------------------------- |
| `--grid-columns`          | `4`             | `8`               | `12`                | `12`             | `tokens.css:399, 426, 446`      |
| `--grid-gutter`           | `16px`          | `20px`            | `24px`              | `32px`           | `tokens.css:400, 427, 447, 465` |
| `--margin-page`           | `16px`          | `24px`            | `32px`              | `48px`           | `tokens.css:401, 428, 448, 466` |
| `--container-max-width`   | `1280px`        | `1280px`          | `1280px`            | `1440px`         | `tokens.css:406, 471`           |
| `--spacing-content-gap`   | `12px`          | `16px`            | `16px`              | `20px`           | `tokens.css:402, 429, 467`      |
| `--spacing-page`          | `16px`          | `24px`            | `24px`              | `32px`           | `tokens.css:403, 430, 468`      |
| `--spacing-section`       | `24px`          | `32px`            | `32px`              | `40px`           | `tokens.css:404, 431, 469`      |
| `--spacing-section-large` | `32px`          | `40px`            | `48px`              | `64px`           | `tokens.css:405, 432, 449, 470` |

Component internals step on a 4px literal grid (`4px`, `8px`, `10px`, `12px`, `16px`, `20px`, `24px`).

### Application Shell

Built in `apps/workspace/src/app/(app)/layout.tsx`, `apps/workspace/src/components/shell/shell.module.css`, `sidebar.module.css`, `header.module.css`, and `apps/workspace/src/styles/globals.css:26-28`:

- **Shell dimensions:** `--bos-sidebar-width: 220px`, `--bos-rail-width: 108px`, `--bos-header-height: 65px`.
- **Sidebar (`sidebar.tsx`, `sidebar.module.css`, `lib/nav.ts`):** Three layouts (`shell.module.css`, `sidebar.module.css`). At `1024px` and wider the sidebar column is `220px` with labels, and a collapse toggle narrows it to the `108px` rail. From `768px` to `1023.98px` it is always the `108px` rail and the collapse toggle is hidden. In the rail a container query (`max-width: 160px`) visually hides the labels, group headings, and user text, leaving icons only (names stay available to assistive technology). Below `768px` the sidebar becomes an off-canvas drawer behind a scrim (`z-index: 40` scrim, `z-index: 50` drawer), opened by the header menu button and closed by its own close button. Navigation groups follow `NAV_GROUPS` in `lib/nav.ts` and are permission-filtered: `Overview`, `Work` (Inbox, Memos), `CRM` (Customers, Leads, Opportunities, Quotations, Verification, Activities & Tasks), `Sales` (Sales Orders, Invoices), `Payments` (Payments, Receivables), `Purchases`, `Payables`, and `System` (Settings). Groups with no visible built item are dropped. An approvals count pill shows on `/inbox` (omitted rather than showing `0` if the read fails). The sidebar footer holds the signed-in user's avatar (the profile-picture dialog trigger when the user has an id, `profile-picture-dialog.tsx`), name, and detail line.
- **Header (`header.tsx`, `header.module.css`):** Sticky top bar (`height: 65px`, `z-index: 10`, `--surface-subtle` `#f8fafc` background, `1px solid var(--border-default)` bottom border). Left side renders the drawer menu button (shown below `768px` only) and the signed-in role label; right side renders quick navigation search, the animated `NotificationsBell` (`app/(app)/notifications-bell.module.css`), and a secondary `Sign out` button.
- **Page container (`page.tsx`, `page.module.css`):** Wraps every route inside `<main>` with `max(24px, var(--spacing-page))` block padding, `--margin-page` inline padding, and `--container-max-width`. Passing `width="narrow"` sets `max-width: calc(720px + 2 * var(--margin-page))`, a `720px` content cap for focused create/edit forms.

- **Figma vs app (Header bar):** Figma renders a pure white (`#ffffff`) header with `"Super Admin"`, three utility icons (cloud, undo, redo), a search input, and a notification bell. The app uses `--surface-subtle` (`#f8fafc`), the live signed-in role label, quick navigation search, an animated notification bell, and a secondary `Sign out` button, with no cloud, undo, or redo icons.
- **Figma vs app (Sidebar navigation and naming):** Figma labels the customer section `"Organizations"` and lists unbuilt entries (Departments in top-level navigation, Projects, Estimates, Recurring Invoices, Contacts, Sales Pipeline, Approvals, Payment Methods, Payment to Confirm, Help). The app hides unbuilt routes, places Organisation, Users, Departments, Access, and Workflows inside `/settings`, adds a `Verification` item under `CRM` and `Purchases` and `Payables` groups, and labels the sidebar link `Customers` while the `/customers` page heading says `Organizations`.

### Real Page Patterns

#### 1. Overview Dashboard (`apps/workspace/src/app/(app)/page.tsx`, `overview.module.css`)

- Greeting header, responsive grid of real-data `StatCard` KPI tiles (failed or unauthorised reads omit their card rather than showing `0`), up to five permission-gated quick-action tiles, and two-column panels for `Waiting for your decision`, recent quotations, `Recent activities`, and `Recent notifications`.
- **Figma vs app (Overview dashboard):** Figma Overview displays six KPI cards (including Active Projects), a hero three-dimensional (3D) illustration, an Export button, a Revenue and Sales Trends chart, and a Pipeline funnel. The app renders live-data KPIs, five permission-gated quick-action tiles, and recent tables/lists, omitting charts, the 3D illustration, and the Export button.

#### 2. List & Table Pages (`apps/workspace/src/app/(app)/leads/page.tsx`, `customers/page.tsx`, `leads.module.css`)

- Vertical rhythm: `PageHeader` (title, short description, primary `LinkButton` action such as `+ Add lead`), optional summary `StatCard` strip, results block containing the filter toolbar (`FilterBar` + view switch where supported + `ResultCount`), then either `EmptyState` (distinct copy for filtered zero-results with `Clear filters` link vs genuinely empty list with primary create action), a Kanban board view (on Leads), or a `.listCard` wrapping `<Table>` and `<Pagination>`.
- Filtering runs as instant URL-backed server-rendered Hypertext Transfer Protocol (HTTP) `GET` requests with debounced fuzzy search and no Apply/Search button (User Interface Preference `UIP-DATA-003`).
- **Figma vs app (Table density, rows-per-page, sticky actions):** Figma specifies 88px row height, a Rows dropdown with an eye icon, and inline quick-action icon groups in each row. The app uses `20px 24px` desktop cell padding (`12px 16px` mobile), `RowMenu` kebab popovers or row links, optional `stickyFirstColumn` (no sticky trailing action column), and inconsistent rows-per-page controls: links on `/leads`, `/quotations`, and `customers/page.tsx`, in the shared `ListPager` (`invoices/_components/list-pager.tsx`, used by invoices, payments, payables inbox, bills, payment requests, procurement requests, RFQs, orders, and vendors) and in `ListFooter` (`components/p2/crm/list-footer.tsx`, used by opportunities, activities, and inbox); a `Select` inside the filter bar on `/sales-orders` (`sales-order-filters.tsx`); and a `Select` on `/settings/users` (`settings/users/page-size.tsx`).
- **Figma vs app (Filter bar controls):** Figma shows blue-outlined filter dropdown buttons with funnel icons. The app renders neutral-bordered `Select` and `MultiSelect` controls (`--select-border`) with instant URL-backed filtering. Known exceptions still present in code: `/payables/vat-register` retains a `Show register` submit button; several procurement forms, the invoice list filters, and the workflow settings panels use native `date` or `datetime-local` inputs instead of `DatePicker`; `/payables/bills/new` keeps a separate `Upload invoice` button after choosing a file; `/vendors/[id]` bank accounts uses an unstyled native file input.

#### 3. Record Detail Pages (`apps/workspace/src/app/(app)/leads/[id]/page.tsx`, `opportunities/[id]/page.tsx`, `memos/[id]/page.tsx`)

- Top breadcrumb back link, `PageHeader` with record title, status `Badge`, and right-aligned action buttons (`HeaderAction` when gated by missing prerequisites, plus dialog triggers).
- Full-width `StatusTimeline` bar showing milestone progression directly beneath the header.
- Two-column desktop layout (main column on left, narrower metadata/action column on right, collapsing to one column below `1024px`) built from `Panel` cards with fact lists, editable forms, attachment rows using `ViewDocument` / `FilePreviewDialog`, and activity logs.
- **Current stage controls (as built today; another active session is revising stage-button behaviour, so only present markup is recorded here):**
  - `apps/workspace/src/app/(app)/leads/[id]/page.tsx` renders `QualifyLead` and `MarkLostDialog` in the header when permitted, `StatusTimeline` below the header, and a right-column `Stage` panel hosting `MoveForm` (`apps/workspace/src/components/p2/crm/move-form.tsx`) excluding `['qualified', 'lost', 'converted']`.
  - `apps/workspace/src/app/(app)/opportunities/[id]/page.tsx` renders quotation actions and `MarkLostDialog` in the header, `StatusTimeline` below the header, and an inline `MoveForm` excluding `['lost']`.
- **Figma vs app (Detail walkthrough banner):** Figma detail screens display a dark walkthrough banner across the top. The app treats that banner as demo-only and omits it.

#### 4. Forms & Settings Pages (`apps/workspace/src/app/(app)/settings/layout.tsx`, `_components/chrome.module.css`, `admin.module.css`)

- Create/edit routes use `<Page width="narrow">` (`720px` max width), stacked `Panel` sections, `Field` wrappers (`Label` + control + hint/error), and bottom form action bars.
- `/settings` wraps all sub-routes in a two-part inner frame: a permission-filtered `SettingsSidebar` on the left and a content pane on the right topped by `SectionTabs` (`TabNav` linking sibling URLs).

#### 5. Centered Auth & Access-Notice Pages (`apps/workspace/src/components/ui/centered-page.tsx`, `components/shell/notice-card.tsx`)

- Full-viewport centered canvas (`CenteredPage`) hosting `NoticeCard`: a split card with `Brand`, one `<h1>`, concise explanation, action buttons, and copyright/support footer on the left, paired with a wide-viewport decorative skeleton aside (`NoticeAside`) on the right. Used by `/auth/error`, `/no-access`, and `/staff-only`.
- **Figma vs app (Login and access-notice screens):** Figma depicts single-step sign-in, a single registration form (Full name, Workspace name, Role, inline password, terms checkbox), an Information Technology (IT) admin password-reset ticket, and three live-data mini dashboard cards in the aside with a large drop shadow. The app follows ZITADEL two-step sign-in, first/last name registration with Passkey or Password selection, email-link password reset, and shorter notice cards with a hairline border and skeleton mini-cards in the aside.

## Elevation & Depth

### Shadow Vocabulary

Business OS is flat by default: cards, tables, and shell regions separate through `1px` `--border-default` hairlines and subtle ground shifts (`#ffffff` on `#f8fafc`), reserving elevation shadows for KPI highlights, dialogs, floating popovers, and toasts.

| Shadow             | Value                                                                   | Applied To                                                                                                                                                                                               | Source                   |
| ------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `--shadow-section` | `0 12px 32px #2c244018`                                                 | `StatCard`, `Panel`, `Dialog`, `Toast`, `Select`/`Combobox`/`MultiSelect`/`DatePicker`/`RowMenu`/`HeaderAction` popovers (overridden to `none` on some flat detail cards such as `leads.module.css:178`) | `tokens.css:188`         |
| `--toast-shadow`   | `0 12px 32px color-mix(in srgb, var(--overlay-scrim) 14%, transparent)` | Fallback only: `Toast`, `Dialog`, `Panel`, and `HeaderAction` write `var(--shadow-section, var(--toast-shadow))`, and `--shadow-section` is always defined, so it never applies                          | `token-overrides.css:27` |

### Focus Rings

Defined in `apps/workspace/src/styles/globals.css` (lines 16 to 23 and 113 to 148):

- **Keyboard focus (`:focus-visible`):** Every interactive control receives `--bos-focus-shadow: 0 0 0 2px var(--focus-ring-offset), 0 0 0 4px var(--focus-ring)` plus `outline: 2px solid transparent` so Windows Forced Colors mode keeps a visible outline.
- **Bordered form fields (`:focus` and `:focus-within`):** Text inputs, textareas, selects, `DatePicker` groups, and `RichTextEditor` roots apply `--bos-field-focus-shadow: inset 0 0 0 1px var(--input-focus-border)` (switching to `--bos-field-focus-shadow-error: inset 0 0 0 1px var(--input-error-border)` when `aria-invalid="true"`) on both pointer and keyboard focus, preventing outer halo clipping inside scroll containers.

### Stacking Context (`z-index`)

| Layer                                                                             | `z-index`                                    | Source                                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Sticky app header                                                                 | `10`                                         | `header.module.css`                                                                              |
| Notifications bell panel                                                          | `30`                                         | `notifications-bell.module.css`                                                                  |
| Mobile sidebar drawer scrim                                                       | `40`                                         | `shell.module.css`                                                                               |
| Mobile sidebar drawer                                                             | `50`                                         | `sidebar.module.css`                                                                             |
| Modal dialog overlay (`Dialog`)                                                   | `100`                                        | `dialog.module.css`                                                                              |
| Modal dialog content (`Dialog`)                                                   | `101`                                        | `dialog.module.css`                                                                              |
| Floating popovers (`Select`, `Combobox`, `DatePicker`, `RowMenu`, `HeaderAction`) | `110`                                        | `select.module.css`, `date-picker.module.css`, `row-menu.module.css`, `header-action.module.css` |
| Toast viewport (`WorkspaceToaster`)                                               | Topmost (`pointer-events: auto` over modals) | `toast.module.css`                                                                               |

### Motion System & Reduced Motion

Every animated surface specifies explicit durations, easing curves, and a `prefers-reduced-motion` fallback.

| Interaction                                 | Duration & Easing                                                                                                                                                                                                                                                                                    | Reduced-Motion Behaviour                                                                                                                                                                                                                                                                       | Source                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Color, border, background hover transitions | `120ms ease` (buttons, inputs, selects, combobox, date-picker, rich-text, icon buttons, bell button)                                                                                                                                                                                                 | Collapsed to `0.01ms` globally                                                                                                                                                                                                                                                                 | `globals.css:163-172`, component CSS modules    |
| Chevron rotation                            | `120ms ease` (`Select`), `200ms ease-out` (`Disclosure`)                                                                                                                                                                                                                                             | Instant state change                                                                                                                                                                                                                                                                           | `select.module.css`, `disclosure.module.css`    |
| DatePicker popover                          | `120ms ease-out` enter (`translateY(-4px) -> 0`), `80ms ease-in reverse` exit                                                                                                                                                                                                                        | Instant                                                                                                                                                                                                                                                                                        | `date-picker.module.css`                        |
| HeaderAction explanation popover            | `140ms ease-out` (`translate: 0 -4px -> 0`)                                                                                                                                                                                                                                                          | Instant                                                                                                                                                                                                                                                                                        | `header-action.module.css`                      |
| Modal `Dialog` overlay & panel              | Overlay: `150ms ease-out` in, `120ms ease-in` out. Panel: `180ms cubic-bezier(0.2, 0, 0, 1)` (`scale 0.97 -> 1`), `120ms ease-in` (`scale 1 -> 0.98`)                                                                                                                                                | Instant                                                                                                                                                                                                                                                                                        | `dialog.module.css`                             |
| Mobile sidebar drawer & scrim               | `260ms cubic-bezier(0.32, 0.72, 0, 1)` open; `200ms cubic-bezier(0.32, 0.72, 0, 1)` close                                                                                                                                                                                                            | Instant                                                                                                                                                                                                                                                                                        | `shell.module.css`, `sidebar.module.css`        |
| Mobile drawer hamburger & close X           | Bar press `90ms cubic-bezier(0.23, 1, 0.32, 1)`; spring release `420ms linear(...)` (~20% overshoot); pull-out `200ms` staggered `0ms / 35ms / 70ms`; close X `220ms cubic-bezier(0.2, 0, 0, 1) 60ms` from `scale(0.25)` + `blur(4px)`                                                               | Instant                                                                                                                                                                                                                                                                                        | `shell.module.css`, `sidebar.module.css`        |
| `ImageUpload` press & spinner               | `--image-upload-ease: cubic-bezier(0.23, 1, 0.32, 1)`, `160ms` press scale (`0.97` avatar / `0.99` drop zone); `700ms linear infinite` spinner                                                                                                                                                       | Press scale removed. The component rule swaps the spinner for a `1.6s ease-in-out infinite` opacity pulse, but the global reduced-motion rule in `globals.css` forces `animation-duration: 0.01ms` and `animation-iteration-count: 1` with `!important`, so the pulse effectively does not run | `image-upload.module.css`                       |
| Loading spinners & skeletons                | `Panel` skeleton shimmer `1.4s ease-in-out infinite`; `FilterBar` busy spinner fades in after `200ms` delay (`opacity 120ms ease 200ms`) and spins `700ms linear infinite`                                                                                                                           | `FilterBar` spin runs only inside `@media (prefers-reduced-motion: no-preference)`; shimmer freezes globally                                                                                                                                                                                   | `panel.module.css`, `filter-bar.module.css`     |
| `NotificationsBell` unread arrival          | Web Animations Application Programming Interface (API) 60 frames per second (fps) damped spring (`zeta = 0.1279`, `w0 = 15.486` radians per second), clapper `1.257x` amplitude lagged `49.7ms`; unread dot spring (`zeta = 0.492`, `w0 = 16.85`, opacity `173ms`), bell triggered `215ms` after dot | Bell does not swing; unread dot fades in over `150ms`                                                                                                                                                                                                                                          | `apps/workspace/src/components/ui/bell-ring.ts` |

**The Global Reduced-Motion Safety Net Rule.** `apps/workspace/src/styles/globals.css` (lines 163 to 172) enforces `@media (prefers-reduced-motion: reduce)` across `*, *::before, *::after`, collapsing `animation-duration` and `transition-duration` to `0.01ms !important`, `animation-iteration-count` to `1 !important`, and `scroll-behavior` to `auto !important`, backed by explicit component-level reduced-motion rules where gentle opacity feedback replaces spin or scale.

**The Popover Portal Rule.** Dropdowns inside modal dialogs (`Dialog`) read `PopoverContainerContext` (`apps/workspace/src/components/ui/popover-container.tsx`) and portal into the dialog content node with `position: absolute`, preventing Radix modal inertness from swallowing pointer clicks on portaled listboxes.

## Shapes

Defined in `apps/workspace/src/styles/tokens.css` (line 189 and lines 353 to 364).

### Border Widths

| Token                   | Value | Usage                                                                                                                                 |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--border-width-thin`   | `1px` | Card outlines, table dividers, form controls, buttons, popovers, and the `ImageUpload` drop zone (dashed at rest, solid on drag-over) |
| `--border-width-medium` | `2px` | Invoice document rule (`invoice-document.module.css`) and colour-picker swatch borders (`colour-picker.module.css`) only              |
| `--border-width-thick`  | `3px` | Toast status inline-start accent bar                                                                                                  |

### Border Radius Scale

| Token             | Value    | Usage                                                                                                                              |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--radius-xs`     | `4px`    | Dropdown option rows (`Select`, `Combobox`, `MultiSelect`, `RowMenu` items), `MultiSelect` checkbox squares, `DatePicker` segments |
| `--radius-md`     | `6px`    | Pagination links, toast action and close buttons, `DatePicker` calendar button, rich-text toolbar buttons, skeleton bars           |
| `--radius-lg`     | `8px`    | Buttons (all sizes), inputs, select triggers, comboboxes, search fields, dropdown panels, tab pills, alerts                        |
| `--radius-status` | `10px`   | Hand-added token (`tokens.css:189`) used on status `Badge` chips (including `MissingPills`)                                        |
| `--radius-xl`     | `12px`   | `Card`, `Panel`, `StatCard`, `Dialog`, `Toast`, `Table` wrapper, `Tabs` list, `EmptyState`                                         |
| `--radius-2xl`    | `24px`   | Declared only: no stylesheet references it                                                                                         |
| `--radius-full`   | `9999px` | Circular `Avatar`, circular `ImageUpload` picture, `Dialog` title icon, `StatusTimeline` markers, notification bell elements       |

**The Nested Radius Rule.** Dropdown panels (`--radius-lg`, `8px`) with `8px` padding around a `4px`-padded list contain option rows rounded to `--radius-xs` (`4px`), and `Card`/`Dialog` containers (`--radius-xl`, `12px`) frame `--radius-lg` (`8px`) inputs and buttons so concentric corners align cleanly.

## Components

All shared components live in `apps/workspace/src/components/ui/` and `apps/workspace/src/components/shell/`. Complex interactive components adopt accessible open-source libraries styled to Business OS tokens (`UIP-BUILD-001`): `react-aria-components` for selects, multi-selects, comboboxes, suggest inputs, and date pickers; `@radix-ui/react-dialog` for modal dialogs; `@radix-ui/react-popover` for non-listbox popovers; `sonner` for toasts; and `@tiptap/react` for rich text. Icons are inlined 24x24 Lucide-style Scalable Vector Graphics (SVG) elements in `apps/workspace/src/components/ui/icon.tsx` (`strokeWidth={2}` default; `1.5` in the sidebar), with no external icon package installed.

### Actions & Buttons

- **`Button` and `LinkButton` (`button.tsx`, `button.module.css`):**
  - Props: `variant` and `size` plus the native `<button>` (or `<a>` for `LinkButton`) attributes. There is no `loading` prop.
  - Variants: `primary` (`--button-primary-bg` = `--action-primary` fill, `--button-primary-text` white). `secondary` and `tertiary` share the `--button-secondary-*` tokens: `--surface-default` fill and `--button-secondary-text` (= `--action-primary`, `#2563eb`); `secondary` adds a `1px` `--button-secondary-border` (also `--action-primary`), `tertiary` has a transparent border. `ghost` is transparent with `--button-ghost-text` (`--text-primary`), turning `--text-link` on hover.
  - Sizes (`min-height`): `small` `34px` (`0 12px`, caption text), `medium` `40px` (default, `0 16px`, body-small text), `large` `48px` (`0 16px`, body-small text), per the Figma exports.
  - States: hover and active step the background (`--button-primary-bg-hover`/`-active`, `--button-secondary-bg-hover`/`-active`, `--button-ghost-bg-hover`/`-active`) over `120ms ease`; `:focus-visible` uses the global `--bos-focus-shadow`; `:disabled` or `aria-disabled="true"` sets `cursor: not-allowed`, a `--button-disabled-bg` fill on `primary`, and `--button-secondary-disabled-text` on the other variants. No opacity change.
  - **Figma vs app (Danger button variant):** Figma defines `button/danger-bg` and `button/danger-subtle-bg` (app tokens `--button-danger-bg`, `--button-danger-subtle-bg`) but no Danger button variant on the Components page. `Button` exposes `primary | secondary | tertiary | ghost` only; destructive red styling (`--button-danger-bg` = `--status-error`, `--error-600`, on Confirm, and a `--status-error` outlined Cancel) is scoped inside `ConfirmDialog` (`dialog.module.css`).
- **`HeaderAction` and `MissingPills` (`header-action.tsx`, `header-action.module.css`):**
  - Renders a page-header action `Button` (it accepts the `Button` props). When the `missing` list is non-empty the button is `aria-disabled="true"` (still focusable, always `type="button"`, never submits); activating it opens a `@radix-ui/react-popover` explanation card (`z-index: 110`, `140ms ease-out`) listing the missing requirements. `MissingPills` renders that list as `error`-tone `Badge` pills (not links).
  - States: enabled (default, hover, focus) and blocked (opens the explanation popover). There is no loading state.
- **`RowMenu` (`row-menu.tsx`, `row-menu.module.css`):**
  - Built on `@radix-ui/react-popover` (`side="bottom"`, `align="end"`, `sideOffset` `8`, `collisionPadding` `8`, `avoidCollisions`). A `34px` ghost kebab trigger opens a panel (`min-width: 160px`, `max-width: min(260px, 100vw - 16px)`, `8px` padding, `--dropdown-bg`, `--radius-lg`, `--shadow-section`, `z-index: 110`) around a `4px`-padded list. Renders nothing when there are no items.
  - Items are either links (`{ label, href }`) or callbacks (`{ label, onSelect }`); there are no disabled or destructive items. Item rows are `40px` (`44px` on coarse pointers), `--radius-xs`, hover and `:focus-visible` `--dropdown-hover-bg`, plus a `2px` inset `--focus-ring` outline on keyboard focus. Arrow keys, Home, and End move between items.

### Form Controls & the Dropdown / Select / Combobox Family

- **`Field`, `Input`, `Textarea` (`field.tsx`, `field.module.css`):**
  - `Field` renders a `<label for>`, the control (a render function receiving `id`, `aria-describedby`, `aria-invalid`, and `aria-labelledby`), an optional hint (`--text-secondary`, caption size), and an optional error (`--status-error`, caption size, medium weight). The hint and error are linked through `aria-describedby`; the error has no `role="alert"`. There is no required indicator.
  - `Input` (`min-height: 42px`, `10px 12px` padding; only the font size changes on coarse pointers) and `Textarea` (`min-height: 120px`, vertical resize) use `--input-border` (`#64748b`), hover `--input-hover-border` (`#334155`), `:focus` inset ring `--bos-field-focus-shadow`, error state (`aria-invalid="true"` switches border and inset ring to `--input-error-border`), and disabled (`--surface-muted` fill, `--text-disabled`, `not-allowed`).
  - **Figma vs app (Field helper text):** Figma's Input (`26:1449`) helper row uses `input/placeholder` (`#64748b`) at `12/20`. The app hint uses `--text-secondary` (`#475569`) at caption size (`12px / 16px`).
- **Dropdown / Select / Combobox Family (`select.tsx`, `multi-select.tsx`, `combobox.tsx`, `combobox-model.ts`, `suggest-input.tsx`, `date-picker.tsx`, `popover-container.tsx`):**
  - Architecture split (`select.tsx:3-18`): `react-aria-components` owns all listbox, combobox, and calendar dropdowns (`Select`, `MultiSelect`, `Combobox`, `SuggestInput`, `DatePicker`); `@radix-ui/react-popover` owns non-listbox disclosure/action popovers (`RowMenu`, `HeaderAction`).
  - Shared floating geometry (`popover-container.tsx`): `placement: 'bottom start'`, `offset: 8`, `shouldFlip: true`, `containerPadding: 8`, portaling into the nearest `Dialog` container when inside a modal. Shared popover chrome (`select.module.css`): `--dropdown-bg`, `1px solid var(--dropdown-border)`, `--radius-lg`, `8px` panel padding, `--shadow-section`, `z-index: 110`, a `4px`-padded list scrolling at max-height `280px`, `40px` option rows (`44px` coarse pointer) rounded to `--radius-xs`, with `--interactive-selected` and `--action-primary` text on the selected row. Triggers are `42px` (`44px` on coarse pointers).
  - **Figma vs app (Dropdown panel):** Figma's Dropdown (`31:128`) open menu uses `12 x 10` padding, an `8px` item gap, `10px` item padding, and Brand/500 (`#3b82f6`) selected text. The app panel uses `8px` padding around a `4px`-padded list, a `4px` item gap, `8px 10px` item padding, and `--action-primary` (`#2563eb`) selected text.
  - **`Select` (`select.tsx`, `select.module.css`):** Single-choice listbox with rotating chevron (`120ms ease`), optional placeholder, keyboard typeahead, hidden native `<input>` for standard Hypertext Markup Language (HTML) form submission. States: default, hover, open (`aria-expanded="true"`), focus, selected (check mark + tint), error (`aria-invalid`), disabled, empty options message.
  - **`MultiSelect` (`multi-select.tsx`, `multi-select.module.css`):** Multi-choice filter/form dropdown rendering custom `18px x 18px` checkbox squares inside listbox rows, trigger text that shows the single selected label or a count (for example `3 statuses`), and a `Clear` action. States: default, hover, open, focus, partially/fully checked, disabled, empty.
  - **`Combobox` (`combobox.tsx`, `combobox-model.ts`, `combobox.module.css`):** Filterable picker over a given option list (local filtering, options grouped by `group` above `groupThreshold`, optional `description` per option) with an optional `addOption` row (`Add "<text>"`). States: default, hover, focus, filtering, empty (`emptyText`), no matches (`noMatchText`, default `No matches.`), invalid, disabled. There is no async search or loading state.
  - **`SuggestInput` (`suggest-input.tsx`):** Free-text input with live autocomplete suggestions built on React Aria `ComboBox` (`allowsCustomValue`), keeping user-typed values valid even when no suggestion matches. States: default, hover, focus, open suggestions, empty, error, disabled.
  - **`DatePicker` (`date-picker.tsx`, `date-picker.module.css`):** React Aria segmented date input (segment order follows the display locale; the form value is always ISO `YYYY-MM-DD` through a hidden native date input) paired with a calendar button opening a popover month grid (`120ms ease-out` enter / `80ms ease-in` exit). Enforces `UIP-FORM-004`. States: default, segment focus, hover, calendar open, selected/today/outside-month/unavailable dates, error (`aria-invalid`), disabled.
- **`SearchInput` (`search-input.tsx`, `search-input.module.css`):** A native `<input type="search">` with a leading `20px` search icon, `--search-border` (`#64748b`), `--radius-lg`, and `min-height: 36px`. There is no custom clear button (only whatever the browser draws for a search input) and no coarse-pointer rule. States: default, hover (`--input-hover-border`), focus (`--input-focus-border`), disabled (`cursor: not-allowed`).
- **`ImageUpload` (`image-upload.tsx`, `image-upload.module.css`, `image-resize.ts`):** Direct click-or-drag-and-drop uploader (`UIP-FORM-001`) with client-side image resize, preview thumbnail, remove button (`UIP-FORM-002`), press scale (`160ms`), and `700ms` upload spinner (see the motion table for reduced motion). States: empty drop zone (`1px dashed var(--border-strong)` on `--surface-subtle`), drag-over (border turns solid `--action-primary` on `--action-primary-subtle`), uploading/loading, populated preview with delete action, error alert, disabled.
- **`RichTextEditor` and `RichText` (`rich-text-editor.tsx`, `rich-text-editor.module.css`, `rich-text.tsx`, `rich-text.module.css`):** TipTap-backed toolbar editor (bold, italic, bulleted list, numbered list) for terms and memo bodies, paired with server-safe `RichText` read-only prose renderer (allow-list sanitized via `richTextToHtml`). States: default, hover, `:focus-within` inset ring, active toolbar toggles, error (`aria-invalid`), disabled/read-only, empty placeholder.
- **Native Checkboxes, Radios & Switches:** No shared `Checkbox`, `Radio`, or `Switch` component exists in `apps/workspace/src/components/ui/`. Forms use native `<input type="checkbox">` and `<input type="radio">` styled with `accent-color: var(--action-primary)` and token borders (`--checkbox-border`, `--radio-border`).
  - **Figma vs app (Checkboxes, radios, switches):** Figma defines custom `22px` Checkbox, `20px` Radio, and `44px x 24px` Toggle/Switch component sets. The app uses native inputs with `accent-color: var(--action-primary)` (plus an `18px x 18px` checkbox square inside `MultiSelect`).

### Data Display & Navigation

- **`Table`, `Th`, `Td`, `CellTitle` (`table.tsx`, `table.module.css`):** A focusable horizontal-scroll region (`--card-border`, `--radius-xl`, `minWidth` default `560`), `<caption className="sr-only">`, header cells on `--table-row-bg` (white) with `--table-header-text` caption-size medium text (not uppercase), `--border-default` row dividers, `20px 24px` cell padding (`12px 16px` below `768px`; `12px` block padding with `stickyFirstColumn`). `Th` and `Td` take `align="start" | "end"` (`end` right-aligns with tabular figures); `Td` also takes `nowrap`. There is no `numeric` prop. Optional `stickyFirstColumn`; `CellTitle` shows a title with a caption-size `meta` beside it and an optional `note` line. States: default, row hover and `:focus-within` (`--table-row-hover-bg` = `--interactive-hover`), empty (parent swaps in `EmptyState`), loading (skeleton or route `loading.tsx`).
- **`FilterBar` and `ResultCount` (`filter-bar.tsx`, `filter-bar.module.css`):** URL-backed `GET` filter container (`UIP-DATA-003`) with debounced search input, instant `Select`/`MultiSelect` triggers, no-JavaScript (JS) Enter submission fallback, a delayed `200ms` busy spinner while navigation is pending, and a polite Accessible Rich Internet Applications (ARIA) live `ResultCount` announcement. States: idle, active filters, pending/loading (spinner after `200ms`), zero-match count.
- **`Pagination` (`pagination.tsx`, `pagination.module.css`):** Link-based Previous / numbered window / Next pagination controls. States: default, hover, current page (`aria-current="page"`, primary tint), focus, disabled Previous/Next at bounds.
- **`Badge` (`badge.tsx`, `badge.module.css`):** Compact status pill (`4px 8px` padding, `--radius-status` `10px`, caption-size medium text, `UIP-DATA-001` one to two words). Seven tones: `neutral` (default; `--surface-muted` / `--text-secondary`), `info` (`--badge-info-bg` / `--badge-info-text`, which resolves to `--status-info`, `--info-600`), `success`, `warning`, `pending` (same style as `warning`), `error` (`-50` tints with `-700` text), and `disabled` (`--input-disabled-bg` / `--input-disabled-text`).
- **`Card`, `Panel`, `StatCard`, `Stack`, `Disclosure`:**
  - `Card` (`card.tsx`, `card.module.css`): Flat `--card-bg` (`--surface-elevated`) container, `24px` padding, `1px solid var(--card-border)`, `--radius-xl`.
  - `Panel` (`panel.tsx`, `panel.module.css`): Titled `Card` with a body-large semibold title, optional description and header actions, `--shadow-section`, and built-in `PanelSkeleton` shimmer (`1.4s ease-in-out infinite`) for loading states.
  - `StatCard` (`stat-card.tsx`, `stat-card.module.css`): KPI `Card` with `20px` padding and `--shadow-section`, a caption-size semibold label, a `24px / 32px` semibold tabular value (a literal size, not the display token), an optional `detail` line, and an optional `28px` icon tile tinted by `tone` (`info | success | warning | error | neutral`, default `info`).
  - `Disclosure` (`disclosure.tsx`, `disclosure.module.css`): Accessible expand/collapse section with `200ms ease-out` rotating chevron.
- **`StatusTimeline` (`status-timeline.tsx`, `status-timeline.module.css`):** Horizontal step bar on record detail pages showing completed, current, upcoming, and terminal (lost/rejected/cancelled) milestones with timestamps or actors.
- **`Tabs` and `TabNav` (`tabs.tsx`, `tab-nav.tsx`, `tabs.module.css`):** Local panel switching (`Tabs`, React Aria) and URL-routed section tabs (`TabNav`, used in `/settings`) share one style: a bordered `--radius-xl` strip with `12px` padding holding `36px` pill tabs (`--radius-lg`). Hover uses `--tabs-bg-hover`; the active tab (`data-selected` or `aria-current="page"`) is a rounded `--interactive-selected` pill with `--tabs-text-active` semibold text. There is no underline indicator. Disabled tabs use `--text-disabled`.
- **`Avatar` (`avatar.tsx`, `avatar.module.css`):** User/entity photo, circular (`.circle`, `--radius-full`) or rounded square (`.square`, `--radius-lg`), with deterministic initials fallback when no image document is stored or image load fails.
- **`EmptyState` (`empty-state.tsx`, `empty-state.module.css`):** Centered empty-collection or zero-filter-match block with icon, short title, explanatory copy, and one clear next action (primary button to create or link to `Clear filters`).

### Feedback, Dialogs & Document Preview

- **`Dialog` and `ConfirmDialog` (`dialog.tsx`, `dialog.module.css`):**
  - Built on `@radix-ui/react-dialog` (`overlay` `z-index: 100`, `--modal-overlay` at 55%; `content` `z-index: 101`). Sizes: `small` (`460px`), `medium` (`560px`, default), `large` (`760px`), `full` (`1200px`, full height). Title: `min(20px, var(--font-size-h3))` on `min(28px, var(--line-height-h3))`, semibold, tight tracking. Description: `--font-size-body-small`, `--text-secondary`. Header padding `20px 56px 20px 24px`, body `20px 24px`, footer `14px 24px`.
  - Enforces a three-part grid: fixed header with close button, independently scrollable body, and fixed footer for actions (`UIP-DLG-001`).
  - `ConfirmDialog` (`UIP-FEED-002`, default size `small`) handles confirmations; when `destructive` is set, the title shows a warning icon, an outside click does not close it, initial focus lands on the red-outlined `Cancel` button (`.dangerCancel`, `--status-error`), and the confirm button takes `--button-danger-bg` (`.danger`, `--error-600`).
  - States: opening/closing motion (`180ms` / `120ms`), pending (both buttons disabled, `aria-busy` on confirm, dialog locked). On failure the dialog stays open; it shows no error itself, so the caller reports it (toast or an `Alert` in `children`).
- **`ActionDialog` (`components/p2/quotations/action-dialog.tsx`):** Wraps the shared `Dialog` with its fixed footer; it has no separate size or shadow.
  - **Figma vs app (Dialogs):** Figma defines `460px` confirm and `760px` workflow dialogs without fixed-footer scroll chrome, and includes dialogs not yet built (Mark Opportunity Won, Assign Project). The app enforces fixed header/scrollable body/fixed footer on `Dialog` (`460 / 560 / 760 / 1200px`).
- **`FilePreviewDialog` and `ViewDocument` (`file-preview-dialog.tsx`, `file-preview-model.ts`, `view-document.tsx`, `file-preview-dialog.module.css`):**
  - Implements `UIP-FORM-003`: opens a `full`-size `Dialog` fetching the file only on open (same-origin URL verified, never uses `<iframe>`), rendering raster images scaled to fit or Portable Document Format (PDF) documents page-by-page via `@bos/pdf-viewer` (`PdfPages`), with `Download` as a secondary footer action and optional `Retry` when regeneration is supported.
  - States: idle (no prefetch), loading spinner, preview rendered, unsupported Multipurpose Internet Mail Extensions (MIME) fallback with Download, fetch error with optional Retry.
- **`WorkspaceToaster` and `toast` (`toast.tsx`, `toast.module.css`):**
  - Headless custom cards powered by `sonner`, anchored top-right below the `65px` header (`visibleToasts={4}`, `--toast-width: 380px`, `Alt+T` keyboard shortcut to focus the toast region). Each card has `12px` padding, `--radius-xl`, a `--toast-border` hairline, and a `3px` status inline-start border. Implements `UIP-FEED-001`.
  - Durations: `4000ms` default (`info`, `success`, `warning`), `5000ms` when an action button is attached, `8000ms` for `error` (which adds `role="alert"`).
  - States: neutral card with 3px status start border (`success`, `warning`, `error`, `info`), optional action button, dismiss close button, hover pause.
- **`Alert` (`alert.tsx`, `alert.module.css`):** Inline banner for blocking form or page-level errors and persistent contextual warnings (`info` default, `success`, `warning`, `error` tints from `--alert-*-bg`, status-coloured icon, `--text-primary` text, `--radius-lg`). `Alert` sets no role itself: callers pass `role="alert"` for interrupting errors or `role="status"` for quiet confirmations.

- **Figma vs app (App-only shared components):** `FilePreviewDialog`, `ViewDocument`, `DatePicker`, `HeaderAction` + `MissingPills`, `FilterBar` + `ResultCount`, `MultiSelect`, `Combobox`, `SuggestInput`, `RichTextEditor`, `ImageUpload`, `Disclosure`, and `WorkspaceToaster` exist as shared code components in `apps/workspace/src/components/ui/` with no dedicated component sets on the Figma Components page.

## Do's and Don'ts

### Grounded Engineering & Product Rules

| Do                                                                                                                                                                                                                                                                                  | Don't                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep all product screens filled with real product content and live permissions only.                                                                                                                                                                                                | Render internal phase labels, demo walkthrough banners, or fake zero counts when an API read fails.                                                         |
| Adopt proven open-source primitives (`react-aria-components`, `@radix-ui/react-dialog`, `@radix-ui/react-popover`, `sonner`, `@tiptap/react`) and style them to `tokens.css` (`UIP-BUILD-001`).                                                                                     | Hand-roll focus traps, custom modal backdrops, or floating listbox positioning from scratch.                                                                |
| Route every dropdown inside a modal through `PopoverContainerContext` (`popover-container.tsx`).                                                                                                                                                                                    | Portal listboxes to `document.body` while a Radix modal dialog is open and marks outside nodes inert.                                                       |
| Keep control borders at `--input-border` (`#64748b`, 4.8:1) and success, warning, and error badge text at `-700` primitives so small controls pass WCAG 1.4.11 and WCAG AA.                                                                                                         | Override inputs back to `#e2e8f0` or success, warning, and error badges back to `-600` text on `-50` tints.                                                 |
| Keep status badge copy to one or two plain words (`Draft`, `Pending`, `Won`, `Overdue`) (`UIP-DATA-001`).                                                                                                                                                                           | Pad badges with filler words like `"Status: Currently Pending Review"`.                                                                                     |
| Prefer fast visual cues with accessible names: use a check mark for true and blank for false in boolean table columns (`UIP-DATA-002`).                                                                                                                                             | Print a red cross (`X`) for a normal false boolean or force users to read prose when a clear icon works faster.                                             |
| Wire list filters as instant URL-backed server-rendered `GET` queries with debounced search, multi-select where multiple values apply, no-JS Enter fallback, and `ResultCount` (`UIP-DATA-003`).                                                                                    | Add manual `Apply` or `Search` submit buttons to filter bars.                                                                                               |
| Start file uploads immediately on file selection or drag-and-drop (`UIP-FORM-001`), provide a filename-specific delete icon button on editable attachments (`UIP-FORM-002`), and open previews in `FilePreviewDialog` with `Download` secondary inside the dialog (`UIP-FORM-003`). | Require a second `"Upload"` click after picking a file, use unlabelled remove buttons, open raw files in iframes, or label a direct download link `"View"`. |
| Use typed inputs (`DatePicker`, bounded percent fields, number steppers, synced linked fields) for structured data (`UIP-FORM-004`).                                                                                                                                                | Fall back to plain `<input type="text">` or native `<input type="date">` where a design-system typed input exists.                                          |
| Send short-lived action feedback to `WorkspaceToaster` (top-right), keep persistent business items in `NotificationsBell`, and keep blocking validation errors inline on fields (`UIP-FEED-001`).                                                                                   | Print transient `"Saved!"` notices inline next to trigger buttons.                                                                                          |
| Open `ConfirmDialog` for confirmations (`UIP-FEED-002`) and keep dialog actions pinned in a fixed footer while the body scrolls (`UIP-DLG-001`).                                                                                                                                    | Expand confirmation prompts inline inside cards or let dialog submit buttons scroll out of sight.                                                           |
| Capture before-and-after browser screenshots or video recordings for every UI or design change shown during review (`UIP-PROC-001`).                                                                                                                                                | Present visual changes in text alone without rendered proof.                                                                                                |

### Index of Kuu's UI Preferences Cited

Source: Kuu's UI preferences (`UIP-*` IDs), kept outside this repository.

- `UIP-FORM-001`: Direct file upload on selection and drag-and-drop (no extra Upload step).
- `UIP-FORM-002`: Clear delete/remove icon button on editable attachments with a filename-specific accessible name.
- `UIP-FORM-003`: Opening a file renders an in-dialog scaled preview (`FilePreviewDialog`), with `Download` secondary inside the dialog; download-only links must be labelled `Download`.
- `UIP-FORM-004`: Typed inputs (`DatePicker`, bounded percents, number steppers, synced linked fields); free text only for free text.
- `UIP-FEED-001`: Short-lived feedback in the top-right toast stack (`WorkspaceToaster`); persistent business items in `NotificationsBell`; blocking form errors inline on fields.
- `UIP-FEED-002`: Confirmations open a dialog (`ConfirmDialog`), never expand inline.
- `UIP-DLG-001`: Dialog actions stay pinned in a fixed footer while the body scrolls.
- `UIP-BUILD-001`: Adopt proven open-source components and style them to system tokens instead of hand-rolling.
- `UIP-DATA-001`: Status labels stay to one or two words max with no filler.
- `UIP-DATA-002`: Visual cues and icons with accessible names over prose when faster; boolean table columns use check mark for true and blank for false.
- `UIP-DATA-003`: Instant URL-backed server-rendered `GET` table filters and debounced fuzzy search with no Apply/Search button, multi-select where applicable, no-JS Enter fallback, and screen-reader `ResultCount`.
- `UIP-PROC-001`: Show before-and-after browser screenshots or video recordings for every UI or design change presented to Kuu.

### Summary of Figma vs App Differences

Each entry states both sides without selecting one:

1. **Form-control borders and hover:** Figma uses `--neutral-200` (`#e2e8f0`) at rest and `--neutral-300` (`#cbd5e1`) on hover; the app overrides them in `token-overrides.css` to `--neutral-500` (`#64748b`) and `--neutral-700` (`#334155`).
2. **Status badge text contrast and neutral tone:** Figma pairs `-50` tints with `-600` status text and defines no neutral badge; the app uses `-700` text for success, warning/pending, and error, keeps `-600` for info, and adds a `neutral` tone in `badge.module.css`.
3. **Letter-spacing units:** Figma stores bare `0.01` / `-0.02` (shown as `px`); the app outputs `0.01em` / `-0.02em` in `tokens.css`.
4. **Composite text styles and H1 height:** Figma defines named composite styles (`Numeric/Large`, `Label/mini`) and a `32px / 44px` Dashboard `h1`; the app uses atomic font tokens, `32px / 40px` desktop `h1`, and caps `PageHeader` titles at `min(24px, var(--font-size-h2))`.
5. **Dark mode:** Figma exposes light mode only; the app pins light mode via `BOS_LIGHT_ONLY = true` and keeps dark-mode CSS overrides that apply only under `data-theme="dark"`, which no code sets.
6. **Checkboxes, radios, and switches:** Figma specifies custom `22px` Checkbox, `20px` Radio, and `44px x 24px` Toggle/Switch components; the app uses native HTML inputs with `accent-color: var(--action-primary)` plus an `18px x 18px` checkbox box inside `MultiSelect`.
7. **Danger button variant:** Figma defines `button/danger-bg` and `button/danger-subtle-bg` colour tokens (app: `--button-danger-bg`, `--button-danger-subtle-bg`) with no Danger button variant on the Components page; the app omits a `danger` variant on `Button` and scopes destructive red styling to `ConfirmDialog`.
8. **Toasts:** Figma defines solid status-filled `--toast-*-bg` tokens with no toast component; the app renders neutral-surface Sonner cards with a 3px status start border and icon.
9. **App-only shared components:** `FilePreviewDialog`, `ViewDocument`, `DatePicker`, `HeaderAction`, `FilterBar`, `MultiSelect`, `Combobox`, `SuggestInput`, `RichTextEditor`, `ImageUpload`, `Disclosure`, and `WorkspaceToaster` exist in code without dedicated Figma Components-page sets.
10. **Header bar:** Figma shows a white (`#ffffff`) header with `"Super Admin"` and cloud/undo/redo utility icons; the app uses `--surface-subtle` (`#f8fafc`), the live role label, navigation search, animated notification bell, and a `Sign out` button.
11. **Sidebar navigation and naming:** Figma labels customers `"Organizations"` and lists unbuilt modules (Projects, Estimates, Recurring Invoices, Contacts, Sales Pipeline, Approvals, Payment Methods, Payment to Confirm, Help); the app hides unbuilt routes, nests administration under `/settings`, adds a `Verification` item under CRM and `Purchases` and `Payables` groups, and labels the sidebar link `Customers` while `/customers` heads with `Organizations`.
12. **Table density, rows-per-page, and row actions:** Figma shows 88px rows, a Rows dropdown with an eye icon, and inline row action icons; the app uses `20px 24px` cell padding, `RowMenu` popovers or links, optional `stickyFirstColumn` (no sticky trailing action column), and mixed rows-per-page controls across list pages.
13. **Filter bar styling and form exceptions:** Figma shows blue-outlined funnel filter triggers; the app uses neutral-bordered `Select`/`MultiSelect` triggers with instant `GET` filtering (with remaining exceptions on `/payables/vat-register`, native date inputs on some procurement forms, a separate Upload button on `/payables/bills/new`, and a raw file input on `/vendors/[id]` bank accounts).
14. **Dialogs:** Figma defines `460px` and `760px` dialogs without fixed-footer scroll chrome plus unbuilt dialogs (Mark Opportunity Won, Assign Project); the app enforces fixed header/scrollable body/fixed footer on `Dialog` (`460 / 560 / 760 / 1200px`).
15. **Overview dashboard and detail walkthrough banner:** Figma Overview includes six KPIs (with Active Projects), a 3D illustration, Export button, and two charts, and detail screens show a dark walkthrough banner; the app shows live-data KPIs, five permission-gated quick actions, recent tables/lists, and omits charts, illustrations, Export, and the walkthrough banner.
16. **Login and access-notice screens:** Figma shows single-step sign-in, combined registration, an IT-admin password-reset ticket, and three live mini-cards with a heavy shadow; the app follows ZITADEL two-step sign-in, Passkey/Password registration, email-link reset, and shorter hairline-bordered notice cards with skeleton mini-cards.
