# Build & release (overview)

How Mirall is built and how updates reach users — the contributor-facing summary. For the
update-system architecture, see [`solution-architecture.md`](./solution-architecture.md)
§1 (How the app ships) and §8 (Update System).

Mirall ships as a standard Electron app that embeds `pear-runtime` as a library —
one binary per platform (`.dmg` / `.msix` / `.AppImage`). Releasing has two stages:

1. **Build** — CI builds the per-platform installers and uploads them to object storage.
2. **Distribute** — each release is promoted to a per-channel Pear Hyperdrive;
   installed clients mirror the new bundle over Hyperswarm and swap it in on the
   next launch (OTA).

```
tag push (v*)          CI: build-electron.yml            distribution
                       ──────────────────────            ────────────
git push --tags ─→ matrix build (5 archs)
                     ├─ macOS: signed + notarized .dmg
                     ├─ Linux: .AppImage (unsigned)
                     └─ Win:   .msix (unsigned → signed out-of-band)
                                      ↓
                     installers → object storage → download page (first install)
                                      ↓
                     promoted to the channel's Pear drive → clients OTA-update
```

## Branches & promotion

`main` is the repo's **default branch** and is **production** — every commit on it is
releasable, and it is what a visitor cloning the public repo gets. `staging` is the
integration branch where the next release accumulates. Features and chores squash-merge
into `staging`, so a merged PR becomes exactly one commit (PR title + PR body). A release
promotes `staging → main` as a pure fast-forward:

```
git switch main && git merge --ff-only staging && git push origin main
```

`main` is kept a strict ancestor of `staging` so that promotion never has to squash, which
is what used to produce the recurring "N ahead / M behind" graph divergence. A hotfix may
land on `main` directly, then gets forward-ported to `staging`.

> **`staging` means two different things.** The git branch `staging` is where code
> integrates. The release channel `staging` is a Pear Hyperdrive (see *Release channels &
> OTA* below). They are independent: a `workflow_dispatch` build can publish any branch to
> any channel.

Because GitHub always pre-selects the repo's default branch as a PR base, new PRs open
against `main`. **Feature and chore PRs must have their base switched to `staging` by
hand** — only a release promotion or a hotfix legitimately targets `main`.

`.github/workflows/pr-base-guard.yml` enforces this: a PR based on `main` fails unless its
head is `staging`, `hotfix/*` or `release/*`. It is an allowlist, so an unfamiliar branch
prefix fails closed. A deliberate exception — an infrastructure change that must land on
`main` first, like the `renovate.json` case below — is unblocked with the `base:main`
label, which should be justified in the PR body.

Renovate is exempt: `renovate.json` sets `"baseBranches": ["staging"]`, so its PRs target
the integration branch regardless of the default. That key must stay on `main` — Renovate
defaults to `useBaseBranchConfig: "none"`, meaning it reads its config **only from the
repo's default branch**. A `renovate.json` that exists on `staging` but not on `main` is
silently ignored.

Long-lived branches are limited to `main` and `staging`. Feature (`feat/*`, `fix/*`) and
release (`release/*`) branches are short-lived and deleted after merge. There is no
permanent branch per version: the channels are build flavors of one commit lineage, not
divergent code, and OTA clients roll forward within a channel, so no released version
needs parallel maintenance. Cut a `release/x.y` branch from its tag only if a patch to an
older line is ever actually needed after `staging` has moved on.

## CI build — `.github/workflows/build-electron.yml`

**Triggers**
- **Tag push `v<version>`** → builds the `prod` channel; version comes from the tag.
- **`workflow_dispatch`** → a maintainer picks `channel` (`dev` / `staging` / `prod`)
  and optionally a single `platform`. Non-prod builds get a unique
  `<version>-<channel>.<run>` string so every build is distinct.

**Pre-flight gates** (tag pushes) — the build refuses to start unless:
1. the tag matches `package.json#version` (no "tagged but forgot to bump"), and
2. the top `## v<version>` heading in `CHANGELOG.md` matches the tag (forces a
   release note into the same commit).

**Build matrix**

| Runner | Arch | Output |
|---|---|---|
| `macos-latest` | `darwin-x64` / `darwin-arm64` | `Mirall.dmg` — signed + notarized |
| `ubuntu-latest` / `ubuntu-24.04-arm` | `linux-x64` / `linux-arm64` | `Mirall.AppImage` — unsigned by convention |
| `windows-latest` | `win32-x64` | `Mirall.msix` — unsigned |

Each job: patch `package.json#version` → `npm install` → `npm run build` (esbuild
bundles the renderer, Tailwind compiles CSS, `tsc --noEmit` typechecks) →
`npm run make:<platform>`:

- **macOS** — `electron-forge make`; `osxSign` + `osxNotarize` run during packaging
  (wired via env in `forge.config.js`) using an Apple Developer ID cert stored in
  repo secrets.
- **Linux** — `electron-forge package` + `scripts/build-app-image.sh` assembles the
  AppImage (shipped unsigned by convention).
- **Windows** — `electron-forge make` with `@electron-forge/maker-msix`. The
  `preMake` hook in `forge.config.js` rewrites the 4-part `Version` in
  `resources/win32/AppxManifest.xml`. CI produces the MSIX **unsigned**; it is
  signed out-of-band by a maintainer (the signing process is internal).

Installers are uploaded to object storage, from which the website's download page
serves first installs.

## Release channels & OTA

Each channel — `dev`, `staging`, `prod` — is a **separate Pear Hyperdrive** with its
own upgrade key. An installed client subscribes to exactly one channel and only moves
within it. The target channel is baked into the bundle at package time:
`forge.config.js` writes the channel's upgrade key into `package.json#upgrade`, which
`src/main/main.js` hands to `pear-runtime` at startup.

First install downloads the installer once over HTTPS. After that, `pear-runtime`
(embedded in the Electron main process) follows the channel's drive over Hyperswarm
and pulls subsequent updates peer-to-peer — no app store, no central update server.

## Versioning & tags

Tags must match `v<MAJOR>.<MINOR>.<PATCH>` or `v<MAJOR>.<MINOR>.<PATCH>-<label><N>`:
- prerelease `<label>` is lowercase (`beta`, `rc`, `alpha`, …);
- prerelease `<N>` is `0`–`65535` (constrained by the MSIX revision range);
- e.g. `v1.0.0`, `v1.2.3-rc2`, `v1.0.0-beta10`.

**Version coupling.** The OTA "update available" banner fires only when the running
app's bundled version differs from the staged release's version, so three values must
agree: the **bundle version** (`package.json#version` at package time), the **MSIX
manifest version** (4-part, derived by `forge.config.js`), and the **staged release
version**. A freshly-installed build and its channel drive therefore carry the same
string, so the updater early-returns instead of looping a banner on every launch.

## Where the rest lives

The operational release pipeline — code signing, channel-drive promotion, and the
seed infrastructure — is documented privately alongside the tooling that runs it.
This document covers only what a contributor needs to understand how the app is built
and how updates reach users.
