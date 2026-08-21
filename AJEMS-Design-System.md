# AJEMS Design System
## Reference for all connectors and companion apps

**Version:** 1.0 · derived from the AJEMS platform redesign (light-blue theme)
**Applies to:** Tally Connector, Excel Bridge, Google Sheets Connector, WooCommerce
Connector, Shopify Connector, and every future connector or desktop companion.

**Companion file:** `ajems-ui.css` — drop it in and use the class names below.
Do not restyle from scratch; extend this file if something is genuinely missing.

---

## 1. Principle

A connector is not a separate product. It is an AJEMS surface that happens to run
on the user's desktop. Someone who uses AJEMS in the browser should be able to open
a connector and feel no seam: same blue, same card, same button, same rhythm.

When in doubt, copy the platform. Invent nothing.

---

## 2. Tokens

All values are CSS variables. **Never hard-code a hex, radius or shadow** — use the
token, so a future platform-wide change flows through every connector.

### 2.1 Colour

| Token | Value | Use |
|---|---|---|
| `--teal` | `#2663EB` | Primary brand blue. Buttons, active nav, links, focus. |
| `--teal-600` | `#1B51CE` | Primary hover. |
| `--teal-700` | `#1946B4` | Pressed, link text, active nav label. |
| `--teal-050` | `#EEF3FE` | Active nav background, soft blue fills. |
| `--bg` | `#F7F9FC` | Page background. |
| `--surface` | `#FFFFFF` | Cards, sidebar, top bar. |
| `--surface-2` | `#F4F7FC` | Hover fills, inset panels, log panes, chips. |
| `--border` | `#E8EDF5` | Standard hairline. |
| `--border-2` | `#D8E1EE` | Input borders, stronger dividers. |
| `--text` | `#1A2233` | Primary text. |
| `--muted` | `#5B6B85` | Secondary text, descriptions. Passes AA. |
| `--subtle` | `#7C8AA0` | Decorative only — icons at rest, group labels. Never body text. |
| `--ok` / `--ok-bg` | `#12B76A` / `#E7F7EF` | Success, connected, on. |
| `--warn` / `--warn-bg` | `#E8890C` / `#FDF1E1` | Pending, attention. |
| `--danger` / `--danger-bg` | `#EF4444` / `#FDEDED` | Errors, destructive. |
| `--info` / `--info-bg` | `#2663EB` / `#EAEFFC` | Informational banners. |

The blue is the only brand colour. Status colours carry meaning and are used
nowhere decorative.

### 2.2 Typography

Two families:

- **Inter** — everything.
- **Space Grotesk** — display only: brand wordmark, big numbers, KPI values
  (class `.disp`). Never body text.

Six steps, nothing in between:

| Token | Size | Use |
|---|---|---|
| `--fs-xs` | 11px | Group labels, table headers, tags, chips |
| `--fs-sm` | 12px | Buttons, field labels, page subtitles, captions |
| `--fs-md` | 13px | Body, inputs, nav items — the default |
| `--fs-lg` | 15px | Card titles, top-bar title |
| `--fs-xl` | 18px | Page titles, stat numbers |
| `--fs-2xl` | 24px | Hero numbers only |

Weights: 400 body, 500 nav/labels, 600 titles and buttons, 700 group labels and
brand. Line height 1.5. Titles use `letter-spacing:-.02em`; uppercase group labels
use `+.08em`.

Numbers in tables, stats and metrics get `font-variant-numeric:tabular-nums` so
columns line up.

### 2.3 Radius

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 8px | Small controls, chips, icon buttons |
| `--r-md` | 12px | Cards, inputs, buttons, nav items |
| `--r-pill` | 20px / 999px | Pills, switches, status badges |

### 2.4 Elevation

Elevation means state, not decoration.

| Token | Value | Use |
|---|---|---|
| `--e-flat` | none | Anything that does not move |
| `--e-low` | `0 1px 2px rgba(16,32,64,.05)` | Cards at rest |
| `--e-hover` | `0 4px 12px rgba(16,32,64,.08)` | Hovered / interactive cards |
| `--e-float` | `0 12px 32px rgba(16,32,64,.16)` | Modals, popovers, menus |

Cards at rest are nearly flat. If everything floats, nothing does.

### 2.5 Motion

One easing — `cubic-bezier(.2,.7,.3,1)` — and three durations:
`--t1` 120ms (hover, colour), `--t2` 180ms (small movement), `--t3` 240ms
(panels, drawers). Respect `prefers-reduced-motion`.

### 2.6 Focus

Every interactive element shows a visible keyboard focus ring:
`--ring: 0 0 0 3px rgba(38,99,235,.20)`. Never remove it.

---

## 3. Layout

```
┌────────────┬──────────────────────────────────────────┐
│  SIDEBAR   │  TOP BAR  (64px, white 90%, hairline)    │
│  250px     ├──────────────────────────────────────────┤
│  white     │  PAGE  (padding 28px 30px 64px)          │
│  hairline  │    page-head: title + sub | actions      │
│  right     │    cards, sections                        │
└────────────┴──────────────────────────────────────────┘
```

### 3.1 Sidebar — `.side`

White (`--surface`), 250px fixed, 1px right border, padding `16px 12px 12px`.
Not dark. Not coloured.

- **Brand** (`.brand`) — logo 132px wide, or a 34px rounded blue mark plus wordmark.
- **Group labels** (`.nav-label`) — 11px, 700, uppercase, `--subtle`, letter-spacing
  `.08em`. Real groups only: WORK, TOOLS, BUILD, CONFIGURE.
- **Items** (`.nav-item`) — 38px tall, 12px radius, 13px, weight 500, icon 18px in
  `--subtle`.
  - hover: `--surface-2` background, text `--text`
  - active (`.on`): `--teal-050` background, `--teal-700` text, weight 600, icon
    `--teal`. **No left bar, no shadow, no glow.**
- Bottom card (`.side-card`) for status or plan info.

### 3.2 Top bar — `.topbar`

64px, `rgba(255,255,255,.9)` with a hairline bottom, sticky. Contains: a home or
back icon button, breadcrumbs (`.crumbs` — 13px `--muted`, current crumb
`--text` 600), then right-aligned status chips and avatars.

### 3.3 Page — `.page`

Padding `28px 30px 64px`. Header (`.page-head`) is a flex row:

- left: `.page-title` (18px, 600, tight tracking) + `.page-sub` (12px, `--muted`)
- right: `.head-actions` — primary action last, secondary before it

Group related cards under a `.sec-label` (11px, 700, uppercase, `--subtle`).

---

## 4. Components

### 4.1 Card — `.card`

```
background: var(--surface);
border: 1px solid var(--border);
border-radius: var(--r-md);
box-shadow: var(--e-low);
padding: 20px;
```

Structure: `.card-title` (15px, 600) → `.card-sub` (13px, `--muted`) →
`.card-body` (margin-top 16px). Interactive cards lift on hover with
`--e-hover` and a `--teal` border. Static cards do not move.

### 4.2 Buttons — `.btn`

Base: inline-flex, gap 7px, 12px, weight 600, padding `8px 14px`, radius
`--r-md`, 1px transparent border, `:active` nudges down 1px.

| Class | Look | Use |
|---|---|---|
| `.btn-primary` | `--teal` fill, white text | One per view — the main action |
| `.btn-ghost` | white, `--border-2` border; hover `--teal-050` + `--teal-700` | Secondary actions |
| `.btn-danger` | `--danger` fill, white text | Destructive confirmation |
| `.btn-sm` | padding `6px 10px` | Inside cards, rows, toolbars |
| `.btn-icon` | 36×36 square | Icon-only |
| `.linkbtn` | no chrome, `--teal-700` text | Inline text action |

Icons are 15px lucide-style outline strokes, `stroke-width:2`.

### 4.3 Inputs — `.input`

```
border: 1px solid var(--border-2);
border-radius: var(--r-md);
padding: 10px 12px;
font-size: var(--fs-md);
```
Focus: border `--teal-600` + `--ring`. Read-only variant `.input.ro` uses
`--surface-2`. Wrap each control in `.field` (column, gap 7px) with a
`.field-label` (12px, 600).

### 4.4 Status

- **Pill** (`.pill`) — 11.5px, 600, padding `3px 10px`, fully rounded.
  Variants: `.p-ok` (green), `.p-warn` (amber), `.p-danger` (red),
  `.p-neutral` (grey), `.p-teal` (blue).
- **Chip** (`.chip`) — 11px, 500, `--surface-2` fill, `--r-sm`. Metadata and
  filters, not status.
- **Tag** (`.tag`) — 10px, 700, uppercase. Terse classification only.
- **Dot** (`.dot`) — 7px circle: `--subtle` idle, `--ok` connected, `--danger` down.

### 4.5 Switch — `.switch`

38×22 track, `--border-2` off, `--ok` on, 18px white knob. Use for on/off
settings where the effect is immediate. Use a checkbox where the change needs
saving.

### 4.6 Banner — `.banner`

Soft informational strip: `--info-bg` fill, 1px `--blue-line` border, radius 11px,
12.5px text, leading icon. For guidance. Not for errors — those belong in the
log or a `--danger` banner.

### 4.7 Empty state — `.empty`

Centred column, 46px padding: 52px rounded `--surface-2` icon tile → 15px 600
title → 13px `--muted` line → one `.btn-primary`.

### 4.8 Table — `.tbl`

12px text, 44px rows, sticky `--fs-xs` headers, hover `--surface-2`, numeric
columns right-aligned with tabular numerals.

---

## 5. Connector-specific patterns

Things every connector needs that the web platform does not have. These are part
of the system — use them consistently across connectors.

### 5.1 Connection card

First card on the main page. Organisation name + secret key in a two-column
`.grid-2`, primary Connect button below, status chips in the top bar.

### 5.2 Activity log — `.log`

`--surface-2` background, 1px `--border`, radius `--r-md`, padding 15px,
monospace 11.5px, line-height 1.7. **Light, not a black terminal.** Plain text;
only `✅` and `❌` as markers. No decorative emoji.

### 5.3 Status chips in the top bar

One chip per dependency (e.g. Tally, AJEMS): `.chip` with a leading `.dot`.
Text reads `Tally: connected` — never a bare icon.

### 5.4 Settings page

Group into cards under section labels: connection → automation → endpoints
(collapsed by default). Page-level actions sit in a footer row **outside** the
last card: destructive on the left, primary Save on the right.

---

## 6. Writing rules

- Sentence case everywhere. No Title Case headings, no ALL CAPS except group labels.
- English only, in every connector, regardless of the user's language.
- Hyphens, not em dashes.
- Say what happens, not what the system did: "Your data will sync every 30 minutes
  while Tally is open."
- Errors state the cause and the fix in the user's words: "AJEMS rejected the
  secret key. Copy it again from your workspace and retry."
- Never expose internals (form IDs, field keys, raw payloads) outside a detailed
  log the user has opted into.

---

## 7. Checklist before shipping a connector UI

- [ ] `ajems-ui.css` is the only stylesheet; no hard-coded hexes or radii
- [ ] Sidebar is white with a hairline border; active item is `--teal-050` + `--teal-700`
- [ ] Exactly one `.btn-primary` per view
- [ ] All text uses one of the six type steps
- [ ] Every input sits in a `.field` with a `.field-label`
- [ ] Focus rings are visible on every control
- [ ] Cards are flat at rest; only interactive cards lift
- [ ] Status uses pills and dots with the semantic colours
- [ ] Log pane is light, not a dark terminal
- [ ] Copy is sentence case, English, hyphens only
- [ ] Placed next to the AJEMS web app, nothing looks out of place

---

## 8. Source

Derived from the AJEMS platform redesign stylesheet (light-blue theme block).
When the platform changes, update `ajems-ui.css` and this document first, then
roll the change into the connectors — never patch a connector on its own.
