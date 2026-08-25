# Dependency Updates

Operational playbook for keeping the Holepunch / Bare / Pear stack and the rest of the dependency tree current. Read this before reviewing a Renovate PR or running a manual sweep.

## What's wired up

- **`renovate.json`** — Renovate config at the repo root. **Renovate reads this file from `main`, not `staging`** — `renovate.yml` runs `actions/checkout` with no `ref`, so it takes the default branch. `baseBranchPatterns: ["staging"]` only controls which branch Renovate *targets*. A config change merged to `staging` alone does nothing; it needs a `hotfix/*` PR to `main` too (the `pr-base-guard` allowlist permits `staging`, `hotfix/*`, `release/*`, or a `base:main` label). Six `packageRules`, in order:
  - routine `minor`/`patch`/`pin`/`digest` — flagged `automerge: true` (squash). **This has never actually fired** — see "Automerge is aspirational" below. The named groups after it override back to manual (`automerge: false`).
  - `major` — `dependencyDashboardApproval: true`. Majors are adopted deliberately and several stay blocked upstream for months, so they queue on the dashboard as checkboxes instead of opening PRs that squat on `prConcurrentLimit` and get re-tested every run. Tick the box when you want one.
  - `pear-runtime` — isolated group, pinned, `prPriority: 10`, `needs-smoke-test` label.
  - `holepunch` — single grouped weekly PR for the whole P2P stack (`b4a`, `corestore`, `debounceify`, `hypercore-crypto`, `paparam`, `sodium-native`, `which-runtime`, `brittle`, `compact-encoding`, plus `bare-*`, `hyper*`, `pear-*` minus `pear-runtime`).
  - `electron` + `@electron-forge/*` — grouped, `needs-smoke-test`.
  - `hyperdht` — `allowedVersions: "<6.33.0"`. 6.33.0 rewrote the LAN shortcut and fails every flow shard on Linux CI while passing on macOS (issue #13); holding it back turned the four-week-red holepunch PR green in one run. Patches on the 6.32 line still flow. Raise only after a Linux runner proves a newer version green. **This rule does not cover `lockFileMaintenance`** — see below.
- **`lockFileMaintenance` bypasses every `packageRules` version cap.** It performs no per-package lookup: it deletes the lock and lets npm re-resolve the whole tree against the ranges in `package.json`, so `allowedVersions` never runs. A cap that lives only in `renovate.json` therefore protects the weekly *update* PRs and not the weekly *lock refresh* PR. Proven: in the same week the `holepunch` group PR (#82) correctly held `hyperdht` at 6.32.0 while the lock-maintenance PR (#87) resolved it to 6.33.2 and turned all six flow shards red. **Any dependency that must not move needs its ceiling expressed in `package.json`** — a `~`/pinned range, plus an `overrides` entry to bind transitives. Keep the two identical: npm fails the install with `EOVERRIDE` if an override disagrees with a direct dependency, which is the tripwire that stops a future range loosening from silently regressing.
- **`prConcurrentLimit: 10`** — Renovate's own default. With majors on the dashboard the limit rarely binds; it can go to `0` (unlimited) if it ever does.
- **Schedule** — Mondays before 8am Europe/Berlin (00:00 → 06:00 UTC during CEST / → 07:00 UTC during CET). Vulnerability alerts run outside the schedule (immediate).
- **`test/raw/holepunch-integration.test.js`** — the merge gate for the `holepunch` group. Spins up an in-memory `hyperdht/testnet`, two Corestores in tmp dirs, two Hyperswarms, and asserts Hyperdrive + Hyperbee replicate end-to-end across namespaced cores. Runs in ~1s.
- **`.github/workflows/test.yml`** — three jobs on every PR and on pushes to `staging` and `main`. There are no path filters, so a docs- or config-only PR still runs the full suite including all six flow shards: a `node` job (`typecheck` + `lint:ci` + `knip` (advisory, `continue-on-error`) + `test:node:core`), a `flow` job (sharded two-peer flow tests), and a `bare` job (`test:bare`). Together they give a Renovate PR its green/red signal.
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

## Automerge is aspirational — merge by hand

`automerge: true` is set for routine bumps, but **it has never once fired**. Verified 2026-08-11 across six PRs (#29, #30, #31, #41, #43, #44): every one was merged manually, including three that sat through two scheduled Renovate runs.

Two independent causes:

1. **GitHub's auto-merge is unavailable here.** It is only offered on PRs that *cannot* be merged immediately — blocked by required status checks or required reviews. The `protect-main-staging` ruleset carries only `deletion` and `non_fast_forward`, no required checks, so every Renovate PR is `MERGEABLE`/`CLEAN` the moment it opens and the option never appears. **Enabling the repo's `allow_auto_merge` setting alone is a no-op** — it is not the fix.
2. **Renovate's native fallback only runs when the workflow runs**, and that cron is weekly. (Timing-consistent hypothesis, not verified in Renovate's logs: `rebaseWhen: behind-base-branch` re-rebases the branch on each run, so CI is pending again at the moment automerge is evaluated.)

Either lever would fix it — a more frequent `renovate.yml` cron, or required status checks on `staging`. Both were considered and declined 2026-08-11 in favour of merging by hand. Treat the flag as intent, not behavior, and don't be misled into thinking a PR will land itself.

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

`hyperdrive` is pinned to an exact version in `package.json` (`"hyperdrive": "13.3.3"`, no caret), so Renovate won't bump it without a manual `package.json` change. The owned-folder sync path (`src/shared/folders/owned-folders.js`) depends on hyperdrive's on-disk/wire behavior, so a version drift carries replication and wire-format risk.

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
