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
`main`.

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

**Patch release** (e.g. `v1.11.2`): once its fixes are backported, a `release-prep/1.11.2` PR to
`release/1.11` bumps `package.json#version` and dates the `## v1.11.2` heading in `CHANGELOG.md`.
When it has merged and the Test run on the release-branch push is green, tag the branch:

```
git fetch origin && git tag v1.11.2 origin/release/1.11 && git push origin v1.11.2
```

Then forward-port the release-prep commit to `main` in a small PR. If `main`'s `package.json` has
already moved ahead, keep `main`'s version and take only the `CHANGELOG.md` section, placed below any
newer `## v…` heading. The tag gate below reads only the release branch's top heading.

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
`release/x.y` branch while a minor stabilises. Channels are build flavors, not branches; any ref can
be built for any channel.

## CI build — `.github/workflows/build-electron.yml`

**Triggers**
- **Tag push `v<version>`** → builds the `prod` channel; version comes from the tag.
- **`workflow_dispatch`** → a maintainer picks `channel` (`dev` / `staging` / `prod`) and optionally
  a single `platform`. Non-prod builds get a unique `<version>-<channel>.<run>` string so every
  build is distinct.

**Pre-flight gates** (tag pushes) — the build refuses to start unless:
1. the tag matches `package.json#version` (no "tagged but forgot to bump"), and
2. the top `## v<version>` heading in `CHANGELOG.md` matches the tag (forces a release note into the
   same commit).

**Build matrix**

| Runner | Arch | Output |
|---|---|---|
| `macos-latest` | `darwin-x64` / `darwin-arm64` | `Mirall.dmg` — signed + notarized |
| `ubuntu-latest` / `ubuntu-24.04-arm` | `linux-x64` / `linux-arm64` | `Mirall.deb` + `Mirall.AppImage` — unsigned by convention |
| `windows-latest` | `win32-x64` | `Mirall.msix` — unsigned |

Each job: patch `package.json#version` → `npm install` → `npm run build` (esbuild bundles the
renderer, Tailwind compiles CSS, `tsc --noEmit` typechecks) → `npm run make:<platform>`:

- **macOS** — `electron-forge make`; `osxSign` + `osxNotarize` run during packaging (wired via env
  in `forge.config.js`) using an Apple Developer ID cert stored in repo secrets.
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
  `~/.config/mirall/`; a deb install retires any per-user AppImage desktop entry.
- **Windows** — `electron-forge make` with `@electron-forge/maker-msix`. The `preMake` hook in
  `forge.config.js` rewrites the 4-part `Version` in `resources/win32/AppxManifest.xml`. CI produces
  the MSIX **unsigned**; it is signed out-of-band by a maintainer (the signing process is internal).

Installers are uploaded to object storage, from which the website's download page serves first
installs.

**Asar layout.** `forge.config.js` seals `src/main`, `src/preload` and the built renderer into an
**uncompressed** `app.asar`, and unpacks `src/worker`, `src/shared`, `node_modules`, `resources` and
every `*.{node,bare}`: Bare cannot load from an archive, `bare-sidecar` `chmod`s its binary on first
launch, `dlopen` cannot read an archive, and native tray/notification APIs need real paths.
`src/main/asar-spawn.js` rewrites `app.asar/` → `app.asar.unpacked/` in spawn paths, because
`require.resolve` returns archive paths the OS cannot exec. OTA swaps the whole bundle, so the
layout does not affect it.

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
