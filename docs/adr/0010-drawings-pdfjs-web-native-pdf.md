# 0010. 2D drawings: PDF.js on web, react-native-pdf + Skia on native

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C10

## Context

Stack v1 said PDF.js for 2D drawings on all platforms. PDF.js does not run natively in React Native without a WebView, and field tablets need smooth native rendering while offline.

## Decision

- **Web/desktop:** PDF.js (`pdfjs-dist`, `*.web.tsx` only).
- **Native (iOS/Android):** `react-native-pdf` for rendering plus a **react-native-skia** markup layer.
- Markups are stored as platform-neutral vector JSON in page coordinates.

## Consequences

Positive:
- Smooth native rendering on field tablets, offline.
- Markups are portable between platforms.

Negative:
- Two rendering stacks to build, test and keep visually consistent. (proposed — needs review)
- Page-coordinate mapping must match exactly between PDF.js and react-native-pdf, or markups drift. (proposed — needs review)
- `react-native-pdf` requires a custom dev build (native module), not Expo Go. (proposed — needs review)

## Alternatives rejected

- **PDF.js on all platforms** (v1): does not run natively in React Native without a WebView.
