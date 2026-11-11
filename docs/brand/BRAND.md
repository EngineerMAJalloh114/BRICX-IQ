# BRICX IQ — Brand Tokens

## Palette (source: palette.jpg)
| Token | Name | Hex |
|---|---|---|
| jet | Jet Black | #1A1A1A |
| onyx | Onyx | #222526 |
| graphite | Graphite | #353A3E |
| ash | Ash | #BFBFBF |
| platinum | Platinum | #E0E0E0 |

## Logos
- `logo-mark.png` — brick "B" mark
- `logo-wordmark.png` — BRICX iQ wordmark
- Raster only, non-transparent background. SVG versions required before P7.

## Functional status colours (owner-approved 2026-11-11)
The brand palette is monochrome and cannot signal state on its own, so status has its own tokens. Contrast is WCAG 2.x, text on the base surface.

| Token | Light | on #FFFFFF | Dark | on #1A1A1A | on #222526 |
|---|---|---|---|---|---|
| success | #1B7F3B | 5.07 | #4CC472 | 7.83 | 6.94 |
| warning | #8A5A00 | 5.93 | #F2B01E | 9.12 | 8.09 |
| danger | #C62828 | 5.62 | #FF6B6B | 6.27 | 5.56 |
| info | #1565C0 | 5.75 | #6AA9FF | 7.24 | 6.42 |

Rules:
- Status text and icons are used on the base surface only (white in light mode, Jet or Onyx in dark mode). On Platinum or Graphite surfaces they fall below 4.5:1 (light 3.84 to 4.49; dark danger on Graphite 4.14), so they are not allowed there.
- Status is never shown by colour alone: every status carries an icon and a text label (colour-blind users, greyscale print, screen readers).
- P7-02 builds these as design tokens and re-checks the ratios in a test.

## Pending decisions (resolve before P7 — Client foundation)
- Primary UI typeface: owner chose option B (IBM Plex Sans + IBM Plex Sans Arabic) on 2026-11-10; open until the P7-02 spike confirms variable builds, app-size cost and tabular numerals (see docs/adr/pending.md). Criteria: open licence, variable, tabular numerals, broad script coverage incl. RTL fallback.
