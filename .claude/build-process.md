# Build & release (overview)

How Mirall is built and how updates reach users — the contributor-facing summary. For the
update-system architecture, see [`solution-architecture.md`](./solution-architecture.md) §1 (How the
app ships) and §8 (Update System).

Mirall ships as a standard Electron app that embeds `pear-runtime` as a library — one binary per
platform (`.dmg` / `.msix` / `.AppImage`). Releasing has two stages:

1. **Build** — CI builds the per-platform installers and uploads them to object storage.
2. **Distribute** — each release is promoted to a per-channel Pear Hyperdrive; installed clients
   mirror the new bundle over Hyperswarm and swap it in on the next launch (OTA).

```
tag push (v*)          CI: build-electron.yml            distribution
                       ──────────────────────            ────────────
git push --tags ─→ matrix build (5 archs)
                     ├─ macOS: signed + notarized .dmg
                     ├─ Linux: .deb + .AppImage (unsigned)
                     └─ Win:   .msix (unsigned → signed out-of-band)
                                      ↓
                     installers → object storage → download page (first install)
                                      ↓
                     promoted to the channel's Pear drive → clients OTA-update
```

## Branches & releases

`main` is the repo's **default branch** and the **development trunk**. Feature, fix and chore PRs
target it (GitHub pre-selects it) and squash-merge, so a merged PR becomes exactly one commit (PR
title + PR body), and `Fixes #N` closes its issue on merge. A commit on `main` is not shipped until
a tag carries it.

Each release line has a long-lived **`release/<major>.<minor>`** branch, and every `v*` tag sits on
one. Release branches are never deleted — they record what each line shipped — and the
`protect-main-release` ruleset blocks their deletion and any non-fast-forward push, as it does for
`main`. Two tag rulesets guard `v*` tags: `protect-release-tags` lets only admins create one, and
`lock-release-tags` lets nobody move or delete one. They are separate because a ruleset's admin
bypass covers every rule in it.

**Fixes go upstream first.** A fix merges to `main`, then is cherry-picked with `-x` onto the release
branch through a `backport/<slug>` PR. Only a fix that no longer applies on `main` lands on the
release branch directly (`hotfix/<slug>`), saying so in its PR body, and is forward-ported to `main`
afterwards.

```
# backport a fix merged to main
git worktree add --no-track -b backport/<slug> worktrees/backport-<slug> origin/release/1.11
git -C worktrees/backport-<slug> cherry-pick -x <main-sha>
gh pr create --base release/1.11 --head backport/<slug>
```

A backport PR carries only cherry-picks, several at once when they go to the same release, and is
**rebase-merged**, never squashed: each fix stays its own commit with its `(cherry picked from
commit …)` line, so every commit on the release branch maps to one on `main`. A fix's changelog
entry arrives with its cherry-pick; a wording change to that entry goes in the release-prep PR, not
the backport, so it reaches `main` with the release-prep forward-port.

**Patch release** (e.g. `v1.11.2`): once its fixes are backported, a `release-prep/1.11.2` PR to
`release/1.11` bumps `package.json#version`, dates the `## v1.11.2` heading in `CHANGELOG.md` and
settles that section's wording.
When it has merged and the Test run on the release-branch push is green, tag the branch:

```
git fetch origin && git tag v1.11.2 origin/release/1.11 && git push origin v1.11.2
```

Then forward-port the release-prep commit to `main` in a small PR. If `main`'s `package.json` has
already moved ahead, keep `main`'s version and take only the `CHANGELOG.md` section, placed below any
newer `## v…` heading. The tag gate below reads only the release branch's top heading.

**A patch is cut on demand, not per fix.** Backports collect on `release/x.y` untagged, and a patch
is tagged only when a fix has to reach users before the next minor. Until then, each backported
fix's changelog entry appears in two places:
- the release branch's top `## v<x.y.z+1>` section;
- `main`'s section for the next minor (`## v<x.y+1>.0` / `### Unreleased`), which is where the fix
  ships if no patch is cut.

If the patch is cut, its forward-port moves those entries out of `main`'s minor section into the
patch section, so each fix is announced once.

**Minor release** (e.g. `v1.12.0`): at feature freeze, cut the branch from `main`, stabilise it with
backports, then release-prep and tag exactly as for a patch:

```
git fetch origin && git push origin origin/main:refs/heads/release/1.12
```

`main` keeps taking features during the freeze; they ship with the next minor.

`.github/workflows/pr-base-guard.yml` guards the release branches: a PR based on `release/**` fails
unless its head is `backport/*`, `hotfix/*` or `release-prep/*`. It is an allowlist, so an
unfamiliar branch prefix fails closed. A deliberate exception is unblocked with the `base:release`
label, which should be justified in the PR body. PRs to `main` are not checked.

Renovate reads its config from the default branch and targets it, so dependency PRs land on `main`.
Release branches get no automatic bumps; a security fix is backported by hand like any other.

The **beta** download (the `staging` release channel, a Pear Hyperdrive — see *Release channels &
OTA* below) is a `workflow_dispatch` build: from `main` during normal development, and from the
`release/x.y` branch while a minor stabilises. Channels are build flavors, not branches: `main` and
any `release/*` branch can be built for `dev` or `staging`; `prod` is built only from a `v*` tag on
its `release/<x.y>` branch.

## CI build — `.github/workflows/build-electron.yml`

**Triggers**
- **Tag push `v<version>`** → builds the `prod` channel; version comes from the tag.
- **`workflow_dispatch`** → a maintainer picks `channel` (`dev` / `staging`) and optionally a single
  `platform`. These builds get a unique `<version>-<channel>.<run>` string so every build is
  distinct. `prod` is not a dispatch option: `gh workflow run build-electron.yml -f channel=prod`
  is rejected before a run starts.

**Pre-flight gates** (tag pushes) — the build refuses to start unless:
1. the tag is `v<MAJOR>.<MINOR>.<PATCH>[-<label><N>]` and its commit is on `release/<MAJOR>.<MINOR>`,
2. the tag matches `package.json#version` (no "tagged but forgot to bump"), and
3. the top `## v<version>` heading in `CHANGELOG.md` matches the tag (forces a release note into the
   same commit).

**Release integrity.** The workflow file runs from the ref being built, so whoever can push a ref
can edit any check written in it; the boundary sits outside the repo files:
- **Environments.** The build job runs in `release` (prod; deployable only from `v*` tags) or `beta`
  (dev/staging; only from `main` and `release/*`). Each holds the Apple signing and R2 secrets and
  has a required reviewer, so every build waits for an approval under *Review deployments* before
  it starts. A branch with an edited workflow reaches neither environment. The `UPGRADE_KEY_*` values
  stay repository secrets: they are public `pear://` links built into every installed app.
- **Write-once releases.** A prod upload is a conditional PUT (`--if-none-match '*'`), and an R2
  bucket lock (`released-artifacts`, prefix `desktop/releases/`, indefinite) refuses any overwrite
  or delete of a released object. A released version is never rebuilt: a matrix row that failed
  before its upload is recovered with *Re-run failed jobs* (never *Re-run all jobs*); anything
  else ships as the next version. The signed MSIX is a new key under `win32-x64/signed/`, so the
  lock allows it — once.
- **Least privilege.** The workflow token is `contents: read`, checkouts do not persist it, and
  expression values reach shell scripts only through `env:`.
- **Pinned inputs.** Every action is pinned to a commit SHA with its version in a trailing comment;
  Renovate's `helpers:pinGitHubActionDigestsToSemver` keeps both current. Build inputs fetched over
  the network go through `scripts/build/lib/fetch-verified.sh`, which refuses a file whose SHA-256
  differs from the pin next to its URL. `test/invariants/release-workflow-hardening.test.js` pins
  all of the above.

**Build matrix**

| Runner | Arch | Output |
|---|---|---|
| `macos-latest` | `darwin-x64` / `darwin-arm64` | `Mirall.dmg` — signed + notarized |
| `ubuntu-latest` / `ubuntu-24.04-arm` | `linux-x64` / `linux-arm64` | `Mirall.deb` + `Mirall.AppImage` — unsigned by convention |
| `windows-latest` | `win32-x64` | `Mirall.msix` — unsigned |

Each job: patch `package.json#version` → `npm ci` → fail if `package-lock.json` changed →
`npm run build` (esbuild bundles the renderer, Tailwind compiles CSS, `tsc --noEmit` typechecks) →
`npm run make:<platform>`:

- **macOS** — `electron-forge make`; `osxSign` + `osxNotarize` run during packaging (wired via env
  in `forge.config.js`) using an Apple Developer ID cert stored in the build environment's secrets.
- **Linux** — `electron-forge make` builds the `.deb` via `@electron-forge/maker-deb`
  (`chrome-sandbox` is recorded setuid root in the package, so the installed app runs with the
  Chromium sandbox on), then `scripts/build/build-app-image.sh` assembles the AppImage from the same
  packaged tree. `scripts/ci/check-deb.sh` asserts the package layout before upload. Both ship
  unsigned by convention. The deb's control `Version` is the CI version with a prerelease label
  rewritten `-beta.N` → `~beta.N` (Debian ordering); the file name follows it. `make:linux` runs the
  deb maker *before* the AppImage script, because forge's `preMake` wipes `out/make`. The deb uses
  xz members (dpkg before Debian 12 cannot read zstd) and turns OTA off (`src/main/install-kind.js`:
  root owns the install, the package manager owns updates). The AppImage cannot keep a setuid
  sandbox, so `resources/linux/AppRun` passes `--no-sandbox`, and it swaps its FUSE runtime for
  uruntime (`URUNTIME_VERSION` in the script) because current distros lack `libfuse2`. Both use
  `~/.config/mirall/`; a deb install retires any per-user AppImage desktop entry. uruntime runs
  before Electron on every AppImage launch, so the script pins two SHA-256 values per arch: the
  release asset (`URUNTIME_SHA256`, the asset's `digest` in
  `gh api repos/VHSgunzo/uruntime/releases/tags/<v>`) and the runtime after its
  `URUNTIME_MOUNT=0` patch (`URUNTIME_PATCHED_SHA256`, `sha256sum` of the patched file on Linux). A
  bump changes the version and all four hashes in one commit; cross-check the patched hash against
  the first bytes of the next built AppImage.
- **Windows** — `electron-forge make` with `@electron-forge/maker-msix`. The `preMake` hook in
  `forge.config.js` rewrites the 4-part `Version` in `resources/win32/AppxManifest.xml`. CI produces
  the MSIX **unsigned**; it is signed out-of-band by a maintainer (the signing process is internal).

**The shipped tree is the tested tree.** The build installs the committed `package-lock.json` with
`npm ci`, the same install `test.yml` runs, and a `git diff --exit-code` step fails the job if the
lock changed. A dependency reaches a release only through a PR that changed the lock and passed CI.
The one lock serves all five matrix rows: npm 11 records every platform's optional native binding
(esbuild, Tailwind oxide, lightningcss, oxc, `@parcel/watcher`, `bare-runtime`) with its
`os`/`cpu`/`libc`, and installs the host's. If a runner ever fails on a missing binding, the lock is
broken — regenerate it on npm 11 from a clean tree; never delete it in CI.
`test/invariants/release-lockfile-install.test.js` pins the install step, the drift check and the
lock's completeness.

Installers are uploaded to object storage, from which the website's download page serves first
installs.

**Asar layout.** `forge.config.js` seals `src/main`, `src/preload` and the built renderer into an
**uncompressed** `app.asar`, and unpacks `src/worker`, `src/shared`, `node_modules`, `resources` and
every `*.{node,bare}`: Bare cannot load from an archive, `bare-sidecar` `chmod`s its binary on first
launch, `dlopen` cannot read an archive, and native tray/notification APIs need real paths.
`src/main/asar-spawn.js` rewrites `app.asar/` → `app.asar.unpacked/` in spawn paths, because
`require.resolve` returns archive paths the OS cannot exec. OTA swaps the whole bundle, so the
layout does not affect it.

**Fuses.** `@electron-forge/plugin-fuses` in `forge.config.js` turns off `RunAsNode`,
`NODE_OPTIONS` and `--inspect` on the packaged binary and turns on `OnlyLoadAppFromAsar` and
embedded asar integrity validation; `scripts/ci/check-fuses.mjs` asserts them on every built binary.
The integrity hash is written into `Info.plist` / the Windows exe resource at package time, covers
only the packed files, and is not checked on Linux. A packaged build also ignores the `MIRALL_*`
levers and `PEAR_DEV_SERVER_URL` (`src/main/env-overrides.js`); automation drives an unpackaged
build.

## Release channels & OTA

Each channel — `dev`, `staging`, `prod` — is a **separate Pear Hyperdrive** with its own upgrade
key. An installed client subscribes to exactly one channel and only moves within it. The target
channel is baked into the bundle at package time: `forge.config.js` writes the channel's upgrade key
into `package.json#upgrade`, which `src/main/main.js` hands to `pear-runtime` at startup.

First install downloads the installer once over HTTPS. After that, `pear-runtime` (embedded in the
Electron main process) follows the channel's drive over Hyperswarm and pulls subsequent updates
peer-to-peer — no app store, no central update server.

## Versioning & tags

Tags must match `v<MAJOR>.<MINOR>.<PATCH>` or `v<MAJOR>.<MINOR>.<PATCH>-<label><N>`:
- prerelease `<label>` is lowercase (`beta`, `rc`, `alpha`, …);
- prerelease `<N>` is `0`–`65535` (constrained by the MSIX revision range);
- e.g. `v1.0.0`, `v1.2.3-rc2`, `v1.0.0-beta10`.

**Version coupling.** The OTA "update available" banner fires only when the running app's bundled
version differs from the staged release's version, so three values must agree: the **bundle
version** (`package.json#version` at package time), the **MSIX manifest version** (4-part, derived
by `forge.config.js`), and the **staged release version**. A freshly-installed build and its channel
drive therefore carry the same string, so the updater early-returns instead of looping a banner on
every launch.

## Where the rest lives

The operational release pipeline — code signing, channel-drive promotion, and the seed
infrastructure — is documented privately alongside the tooling that runs it. This document covers
only what a contributor needs to understand how the app is built and how updates reach users.
