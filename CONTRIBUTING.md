# Contributing to Mirall

Thanks for your interest in improving Mirall! This document covers how to
contribute and the one piece of paperwork we require: a Contributor License
Agreement (CLA).

## Scope

This repository is entirely open source under AGPL-3.0, and contributions to
any part of it are welcome. Mirall's proprietary, paid components — the hosted
relay, backup, and blind-peer services and the entitlement API — live in a
separate private repository and are not part of this codebase.

## Why a CLA?

Mirall is **open-core**: the core is free and open source under AGPL-3.0, and a
separate commercial edition funds the project. To keep offering both, the
project's maintainer needs the rights to use contributed code under *both* the
AGPL and a commercial license. The CLA grants exactly that — you keep the
copyright to your contribution and grant the maintainer a broad license to use
it. You are not signing your work away; you are letting it ship in both
editions. (This is the same pattern used by projects like Apache, .NET, and
Kubernetes.)

## Signing the CLA

We use **CLA Assistant** to collect signatures automatically:

1. Open your pull request as usual.
2. The CLA Assistant bot comments on the PR with a link.
3. Read [`CLA.md`](./CLA.md), then reply on the PR with the sign-off sentence
   the bot gives you (one comment, recorded against your GitHub account).
4. You only sign once — future PRs are recognized automatically.

A PR cannot be merged until its author (and any co-authors) have signed.

## Development setup

```bash
npm install
npm run build      # type-check + bundle
npm run dev        # watch-mode dev (see README "Building from source")
```

Mirall is a P2P app, so most features need two running instances to test —
see **Two-peer testing** in the [README](./README.md).

## Before you open a PR

- **Base branch.** Open PRs against `staging`, the default integration branch —
  not `main`, which is production. GitHub preselects this for you.
- **Tests.** Every change ships with test coverage at the layer(s) it touches.
  Run `npm test` (and `npm run test:fe` for renderer/UI changes).
- **Lint & types.** `npm run build` runs ESLint (including `jsx-a11y`) and
  `tsc --noEmit`; both must pass.
- **Accessibility.** UI changes must keep the a11y bar — every interactive
  control needs an accessible name, role, and state.
- **Commit style.** Short, imperative, square-bracketed type prefix, e.g.
  `[fix] Clamp peer avatar size`, `[feat] Add folder tree view`.

## Code comments

Comments state what the code cannot say itself — a module's purpose, a
non-obvious invariant, an external constraint (wire compatibility, on-disk
format, OS quirk), or why the simpler-looking alternative is wrong. Keep them
purpose-driven and self-contained:

- Every non-trivial module opens with a short `//` header: what it owns, where
  it sits in the process topology, key invariants.
- Write rules in the present tense ("keys are always relative, `/`-separated"),
  never history ("this used to break when…") or references to issues, PRs, or
  internal tracker IDs — a reader without access to those must understand the
  comment on its own. `.claude/solution-architecture.md` (and its glossary) is
  the only document comments may point to.
- Domain terms (SCK, catalog, mirror, …) are defined in the
  [architecture glossary](./.claude/solution-architecture.md#17-glossary);
  expand or link a term on first use in a file.
- Prefer no comment over a redundant one; JSDoc only where parameter shapes
  genuinely help on an exported helper.

`scripts/check-comment-hygiene.sh` enforces the self-containment rules in CI.

## Reporting bugs & security issues

- **Bugs:** open a GitHub issue with steps to reproduce.
- **Security vulnerabilities:** please do **not** open a public issue. Email
  security@mirall.app so we can triage and fix before disclosure.
