# 0011. BIM viewer is web/desktop only

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C11

## Context

Stack v1 said That Open Engine + Three.js everywhere. web-ifc (WASM) + WebGL is not a supported path inside React Native, and BIM is optional per v1.

## Decision

The BIM viewer runs on **web/desktop (PWA, or Tauri if ADR 0021's trigger is met) only**. Tablets open it through the browser/PWA. The native app shows linked element metadata, not the 3D model. BIM arrives in Release 3 (P22).

## Consequences

Positive:
- Avoids an unsupported WASM + WebGL path inside React Native.
- Tablets can still open the model through the browser/PWA.

Negative:
- Native users switch to the browser to see the model, a context switch in the field. (proposed — needs review)
- Offline model access on tablets depends on browser storage quotas (see ADR 0021). (proposed — needs review)

## Alternatives rejected

- **That Open Engine + Three.js in every client** (v1): not supported inside React Native.
