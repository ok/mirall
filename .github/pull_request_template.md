<!-- See .claude/testing.md for the layers, the change-type → coverage matrix, and the a11y bar. -->

## What & why


## Test coverage
Pick the layer(s) this change touches (not all of them always — see the matrix).

- [ ] **Unit** (`test/unit`) — pure logic / validators / encoders / IPC dispatch
- [ ] **Integration** (`test/integration`) — single-peer data layer (corestore / hyperdrive / swarm)
- [ ] **Flow / two-peer** (`test/flow`) — P2P behavior (sync, transfer, membership, mirror, leave)
- [ ] **Frontend** (`test/frontend`, local) — user-facing UI flow
- [ ] **N/A** — docs / comments / config only (no runtime surface)

- [ ] Bug fix? A red-first `REGRESSION (FIX-N: …)` test was added at the bug's layer.
- [ ] `npm test` (unit + integration) and `npm run build` (lint + typecheck) pass locally.

## Accessibility (required for any UI change)
- [ ] `npm run lint` clean (eslint-plugin-jsx-a11y).
- [ ] Dev `@axe-core/react` adds no new serious/critical violations.
- [ ] Every new/changed control has an accessible name + role + state (keyboard-reachable; status uses `aria-live`/`role`).
- [ ] `npm run test:fe` run locally for UI-affecting changes (headless CI can't) — flows exercised: _____
- [ ] N/A — no UI change.
