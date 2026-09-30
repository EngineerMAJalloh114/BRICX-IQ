# 0008. Styling: NativeWind (Tailwind)

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C8

## Context

Stack v1 left styling open: Tamagui **or** NativeWind. One Expo client targets iOS, Android and web, and some screens are web-only.

## Decision

Use **NativeWind (Tailwind)** with React Native Reusables-style primitives (`@rn-primitives/*`) in `packages/ui`. Tailwind is pinned to exactly the version NativeWind's stable release requires.

## Consequences

Positive:
- One styling system across all platforms.
- Tailwind knowledge transfers to web-only screens.

Negative:
- Tailwind's major version is capped by NativeWind's stable release, so we cannot adopt new Tailwind majors independently. (proposed — needs review)
- Some native styling behaviour differs from web CSS and needs per-platform testing. (proposed — needs review)
- Class-string styling needs discipline (tokens, `start/end` for RTL) to stay consistent. (proposed — needs review)

## Alternatives rejected

- **Tamagui**: v1 alternative; banned in DEPENDENCIES.md.
- **styled-components, @emotion/\***: banned in DEPENDENCIES.md as duplicate styling systems.
