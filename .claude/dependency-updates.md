# Dependency Updates

Operational playbook for keeping the Holepunch / Bare / Pear stack and the rest of the dependency tree current. Read this before reviewing a Renovate PR or running a manual sweep.

## What's wired up

- **`renovate.json`** — Renovate config at the repo root. Four `packageRules`: an unnamed first rule auto-merges routine `minor`/`patch`/`pin`/`digest` bumps (`automerge: true`, squash) once CI is green; the three named groups below come after and override it back to manual (`automerge: false`):
  - `pear-runtime` — isolated group, pinned, `prPriority: 10`, `needs-smoke-test` label.
  - `holepunch` — single grouped weekly PR for the whole P2P stack (`b4a`, `corestore`, `debounceify`, `hypercore-crypto`, `paparam`, `sodium-native`, `which-runtime`, `brittle`, `compact-encoding`, plus `bare-*`, `hyper*`, `pear-*` minus `pear-runtime`).
  - `electron` + `@electron-forge/*` — grouped, `needs-smoke-test`.
- **Schedule** — Mondays before 8am Europe/Berlin (00:00 → 06:00 UTC during CEST / → 07:00 UTC during CET). Vulnerability alerts run outside the schedule (immediate).
- **`test/raw/holepunch-integration.test.js`** — the merge gate for the `holepunch` group. Spins up an in-memory `hyperdht/testnet`, two Corestores in tmp dirs, two Hyperswarms, and asserts Hyperdrive + Hyperbee replicate end-to-end across namespaced cores. Runs in ~1s.
- **`.github/workflows/test.yml`** — three jobs on every PR and push to `main`: a `node` job (`typecheck` + `lint:ci` + `knip` (advisory, `continue-on-error`) + `test:node:core`), a `flow` job (sharded two-peer flow tests), and a `bare` job (`test:bare`). Together they give a Renovate PR its green/red signal.
- **`.github/workflows/renovate.yml`** — self-hosted Renovate runner. Fires Mondays at 01:00 UTC and on manual `workflow_dispatch`. The cron must fire inside the `renovate.json` schedule window — `before 8am Europe/Berlin` gives ~5h of slack to absorb GitHub Actions cron delay (which routinely runs 30–90min late). Authenticates via the `RENOVATE_TOKEN` repo secret (a fine-grained PAT — required instead of `GITHUB_TOKEN` so PRs opened by Renovate trigger the test workflow).

## Regular cadence

| What | When | Who |
|---|---|---|
| Renovate opens grouped PRs | Mondays automatically | Renovate |
| CI runs typecheck + tests on each PR | on PR open / push | GitHub Actions |
| Review `holepunch` group PR | weekly, fast if green | maintainer |
| Review `pear-runtime` PR | when present, deliberate | maintainer + smoke test |
| Review `electron` PR | when present, deliberate | maintainer + smoke test |
| Security PR | any time, fast-track | maintainer |

## Green-path workflow (the common case)

For the weekly `holepunch` group PR, when CI is green:

1. Open the PR. Renovate auto-includes changelog links per package.
2. Skim the per-package changes. Holepunch repos sometimes ship behavior changes inside minor bumps — flag anything that looks like a wire-format or replication change for closer review.
3. Confirm the `Test` workflow ran and is green.
4. Squash-merge.

Total time: ~2 minutes.

## Smoke-test workflow (pear-runtime, electron, anything `needs-smoke-test`)

These changes can break things the integration test does not cover (the Bare worker boot, native module ABI, OTA, packaging, the UI):

1. `gh pr checkout <num>`
2. `npm ci && npm run start`
3. Two-window smoke:
   - Create a space, generate the invite.
   - In a second instance (different storage path, e.g. `npm run start -- --storage=/tmp/mirall2`), accept the invite.
   - Transfer a file. Confirm both peers see it.
   - Quit both, restart both, confirm spaces resume and transfers complete.
4. If pear-runtime: also build at least one platform (`npm run make:darwin` locally) and confirm the DMG launches.
5. Merge.

## pear-runtime — extra care

`pear-runtime` is the host process; bumping it can change Bare ABI and break native modules (`sodium-native`, `bare-fs`, `bare-https`, `bare-os`, `bare-path`, `bare-subprocess`). It is pinned (no caret) for a reason.

Before merging:
- Read the `pear-runtime` and `bare` release notes for ABI/breaking changes.
- Run a full local `make` for at least one platform.
- If there's a corresponding bump pending in the `holepunch` group (especially `bare-*` packages), consider landing them together rather than separately.
- After merging and shipping, watch the OTA channel for crash reports for ~24h before tagging the next release.

**The Bare that ships in production rides on `bare-sidecar`'s baked-in prebuild.** Any lockfile re-resolution — `npm update`, a Renovate lock-maintenance PR, a full lock regen — can therefore bump the production Bare with no visible change to `bare` in `package.json`. Review the `bare-sidecar` diff on every lockfile-only PR, and smoke-test the worker whenever it moves.

## hyperdrive — pinned

`hyperdrive` is pinned to an exact version in `package.json` (`"hyperdrive": "13.3.2"`, no caret), so Renovate won't bump it without a manual `package.json` change. The owned-folder sync path (`src/shared/folders/owned-folders.js`) depends on hyperdrive's on-disk/wire behavior, so a version drift carries replication and wire-format risk.

There is **no** automated pin-guard test — nothing fails CI when the version changes. Any manual hyperdrive bump is therefore a `needs-smoke-test` candidate: re-read the release notes for replication/wire-format changes, run the two-window smoke test, and confirm end-to-end replication before merging.

## Security PRs

Renovate's `vulnerabilityAlerts` rule bypasses the weekly schedule. When one shows up:

1. Read the advisory linked in the PR body.
2. If the vulnerable code path is reachable from our app, fast-track: review, run CI, merge same-day.
3. If the dep is transitive-only and not on a reachable code path, treat as a normal PR but still merge within the week.

## Manual sweep (if Renovate is paused or unavailable)

Run periodically (~every 2 weeks) from a fresh branch:

```sh
# See what's behind
npm outdated

# Bump caret ranges across the Holepunch family in package.json
npx npm-check-updates -f '/^(pear-|bare-|hyper|corestore|b4a|sodium-native|protomux|paparam|which-runtime|brittle|debounceify|hypercore-crypto)/' -u

# Reinstall + verify
npm install
npm run typecheck
npm test
```

Then do the smoke test from the section above before merging. Do **not** include `pear-runtime` in the auto-bump — handle it deliberately.

## Where to look when something breaks

- Test fails after a `holepunch` bump → check the diff in `node_modules/<pkg>/` against the previous version, especially around replication / wire format.
- Typecheck fails after a `@types/*` bump → usually a single API surface change in React/Node typings; revert or follow the upstream fix.
- App boots but spaces don't replicate after `pear-runtime` bump → check Bare ABI mismatch in `sodium-native` / `bare-fs` (look for `NODE_MODULE_VERSION` errors in the worker log).
- DMG/MSIX build fails after Electron bump → likely `electron-forge` version mismatch; bump `@electron-forge/*` together (the `electron` group rule does this).

**Diff a failing test against the no-change baseline before blaming the bump.** A bump's blast radius is only what it changes — data-layer `node_modules`. If the renderer + harness + scenarios are byte-identical to `main`, a renderer/harness/test-string failure is pre-existing *by construction*. Confirm both directions: the headless gate green under the new deps AND a baseline run (merge-base / `main`) failing the same way WITHOUT them. Read the literal failing key first — don't let an invocation artifact (comma-split CLI args) masquerade as a code failure.

## One-time setup

To activate the loop on a fresh clone or after rotating credentials:

1. Generate a [fine-grained PAT](https://github.com/settings/personal-access-tokens) scoped to this repo only with permissions: contents:write, pull-requests:write, issues:write (required for the dependency dashboard issue), metadata:read, workflows:write. Set a long expiry (1y) and add a calendar reminder to rotate.
2. Add it as repo secret `RENOVATE_TOKEN` (Settings → Secrets and variables → Actions → New repository secret).
3. Trigger the workflow once manually (Actions → Renovate → Run workflow) to confirm it runs cleanly. Use `logLevel: debug` for the first run.
4. Renovate detects the existing `renovate.json` and skips the onboarding PR, opening real dependency PRs on the next scheduled tick.

## Future work (not done)

- Boot-test job: spawn the Electron app headlessly in CI, confirm the worker reaches "ready". Closes the gap that the integration test runs without the actual Bare worker.
- `npm audit` step alongside Renovate vulnerability alerts.
- Renovate `automerge` for pure patch bumps in the `holepunch` group, gated on green CI. Defer until the boot-test job exists.
