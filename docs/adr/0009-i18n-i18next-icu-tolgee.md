# 0009. Internationalisation: i18next + ICU, Intl APIs, Tolgee

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C9

## Context

Stack v1 left i18n open: i18next **or** FormatJS. The platform is multi-language from day one, including right-to-left scripts, and needs correct plurals and genders.

## Decision

Use **i18next + react-i18next + i18next-icu** (ICU MessageFormat) at runtime, with the `Intl` APIs for numbers and dates. Use **Tolgee** (self-hosted) for translation management. RTL is supported from day one.

## Consequences

Positive:
- One translation runtime.
- ICU plurals and genders.
- Self-hosting Tolgee keeps owner control.

Negative:
- ICU syntax is harder for translators and developers than plain key-value strings. (architect-reviewed 2026-09-30)
- Tolgee is another self-hosted service to run and back up. (architect-reviewed 2026-09-30)
- `Intl` data differs across JavaScript engines (Hermes, browsers), so formatting must be tested per platform. (architect-reviewed 2026-09-30)

## Alternatives rejected

- **FormatJS / react-intl**: v1 alternative; banned in DEPENDENCIES.md.
