# Pending business decisions

Open decisions that block later roadmap tasks. When one is made, record it as a new ADR and remove it from this list.
All are owned by **Mohamed Abass Jalloh**. "Needed by" is the earliest ROADMAP.md task that depends on the decision.

| Decision | Owner | Needed by | Options already named |
|----------|-------|-----------|-----------------------|
| Launch regions | Mohamed Abass Jalloh | P6-01 (global directory service); also P13-01 environments | STACK.md C20: `af-south-1` (Cape Town) and `eu-west-1` as the starting cells. |
| First 2–3 payment providers | Mohamed Abass Jalloh | P17-03 (first payment adapters) | STACK.md names only the kinds: mobile money, gateways, banks. Named elsewhere: ROADMAP.md P17-03 lists Orange Money or Afrimoney (Sierra Leone mobile money), Flutterwave or Paystack (card/aggregator), one bank/transfer route; DEPENDENCIES.md §9 also lists Stripe. |
| Launch languages | Mohamed Abass Jalloh | P3-03 (`@bricx/i18n` locale files); reviewed at P14-04 | STACK.md names none. ROADMAP.md uses `en`/`fr`/`ar` in the P2-04 seed and Arabic (RTL) + English in the P7 exit criteria. |
| Launch currencies | Mohamed Abass Jalloh | P9-02 (FX feeds for launch countries) | STACK.md names none as launch currencies (it cites JPY, BHD, SLE only as minor-unit examples). ROADMAP.md P2-04 seeds USD, EUR, SLE, NGN, KES, GHS. |
| Primary UI typeface | Mohamed Abass Jalloh | P7-02 (design system) | STACK.md names none. docs/brand/BRAND.md criteria: open licence, variable, tabular numerals, broad script coverage including RTL fallback. |
| Functional status colours (success / warning / danger / info) | Mohamed Abass Jalloh | P7-02 (design system) | STACK.md names none. docs/brand/BRAND.md: the brand palette is monochrome and cannot signal state on its own. |
| ~~TypeScript major: stay on 5.9.x vs adopt 6.x or 7.x~~ **Resolved → [ADR 0026](0026-typescript-stays-on-5-9.md) (2026-09-30): stay on 5.9.x** | Mohamed Abass Jalloh | P1-03 (typescript-eslint supported range) | 5.9.3 (current pin), 6.0.x, 7.0.x — evidence in P1-01 PR and P1-03 PR. |
| ESLint major: 9.39.x (maintenance) vs 10.x | Mohamed Abass Jalloh | Before P3 | Depends on typescript-eslint + eslint-plugin-boundaries support for 10. 9.39.5 pinned at P1-03; 10.11.0 is npm `latest`. |
