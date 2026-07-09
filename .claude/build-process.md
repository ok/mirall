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
