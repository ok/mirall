const path = require('path')
const fs = require('fs')
const os = require('os')

const pkg = require('./package.json')
const appName = pkg.productName || pkg.name

// appdmg only hides .background/ and .VolumeIcon.icns by leading dot. Finder
// renders both as soon as the user has "Show hidden files" on (Cmd+Shift+. or
// AppleShowAllFiles=YES). create-dmg / electron-builder also chflags them so
// they stay hidden in column view and other Finder code paths. We do the same
// by re-mounting the produced DMG read-write, applying UF_HIDDEN, and
// reconverting back to ULFO over the original.
function hideDmgInternals(dmgPath) {
  const { execFileSync } = require('child_process')
  const stamp = `${process.pid}-${Date.now()}`
  const tmpDmg = path.join(os.tmpdir(), `mirall-dmg-rw-${stamp}.dmg`)
  const mountPoint = path.join(os.tmpdir(), `mirall-dmg-mnt-${stamp}`)
  try {
    execFileSync('hdiutil', ['convert', dmgPath, '-format', 'UDRW', '-o', tmpDmg, '-quiet'])
    execFileSync('hdiutil', ['attach', '-nobrowse', '-noverify', '-mountpoint', mountPoint, tmpDmg, '-quiet'])
    try {
      for (const name of ['.background', '.VolumeIcon.icns']) {
        const target = path.join(mountPoint, name)
        if (fs.existsSync(target)) execFileSync('chflags', ['-h', 'hidden', target])
      }
    } finally {
      execFileSync('hdiutil', ['detach', mountPoint, '-quiet'])
    }
    execFileSync('hdiutil', ['convert', tmpDmg, '-format', 'ULFO', '-ov', '-o', dmgPath, '-quiet'])
    console.log(`Hid DMG internals on ${path.basename(dmgPath)}`)
  } finally {
    try { fs.rmSync(tmpDmg, { force: true }) } catch {}
  }
}

function getWindowsKitVersion() {
  const root = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin'
  try {
    const dirs = fs.readdirSync(root)
      .filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d))
      .sort()
    if (!dirs.length) return undefined
    return dirs[dirs.length - 1]
  } catch {
    return undefined
  }
}

const isWindows = process.platform === 'win32'

// Forge / electron-packager takes a single `icon` base path and resolves the
// extension per platform (.icns / .ico / .png). Each lives under its own
// platform dir, so we pick the right base at config-load time. CI runs the
// matching platform job on a matching runner, so process.platform on each
// host always matches the artifact being built.
const iconBase = {
  darwin: path.join(__dirname, 'resources', 'darwin', 'icon'),
  win32:  path.join(__dirname, 'resources', 'win32',  'icon'),
  linux:  path.join(__dirname, 'resources', 'linux',  'icon'),
}[process.platform]

let packagerConfig = {
  name: appName,
  executableName: appName,
  appBundleId: 'com.mirall.app',
  icon: iconBase,
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true,
  // Sidecar copy of package.json next to app.asar (Contents/Resources/ on
  // macOS, resources/ elsewhere). The runtime reads it from inside app.asar
  // via require('../../package.json') from src/main/main.js, but the seed-host
  // stage script needs to read #version from a plain file with `node -p` to
  // validate the prod tag matches what CI baked in. See
  // seed-host/scripts/build-stage-artifact.sh.
  extraResource: [
    path.join(__dirname, 'package.json'),
    path.join(__dirname, 'CHANGELOG.md'),
  ],
  // Asar bundles src/main, src/preload and assets/ into a single binary blob
  // so casual users can't browse the renderer source after install. Everything
  // Bare touches must stay on the real filesystem: Bare is a separate C
  // runtime with no asar support, so it can't read JS, .bare modules, or the
  // worker entry from inside the archive. bare-sidecar also chmods its own
  // binary, which would fail on a read-only asar path. Native .node modules
  // need dlopen, which also can't read from asar.
  asar: {
    // unpack matches file basenames (matchBase: true) — covers any native
    // binary anywhere in the tree we may have missed.
    unpack: '*.{node,bare}',
    // unpackDir matches directory paths relative to the package root.
    // src/worker + src/shared must be unpacked because Bare requires them
    // from the real filesystem. node_modules must be unpacked because Bare
    // requires its own deps from disk. resources must be unpacked so
    // Notification's native backends (NSImage / Toast / libnotify) can read
    // the per-platform icon — those APIs don't traverse asar.
    unpackDir: '{src/worker,src/shared,node_modules,resources}',
  },
  // Inject UPGRADE_KEY into the bundled package.json. readPackageJson can't
  // do this — it only mutates an in-memory copy that's thrown away before
  // asar bundling, so the asar would pick up package.json from disk (which
  // has no upgrade field by design — see hooks.readPackageJson below).
  // afterCopy fires after electron-packager stages files but before asar
  // seals, so edits to buildPath/package.json land in the shipped app.asar.
  afterCopy: [
    (buildPath, _electronVersion, _platform, _arch, callback) => {
      if (!process.env.UPGRADE_KEY) {
        return callback(new Error('UPGRADE_KEY env var unset in afterCopy — readPackageJson should have caught this earlier'))
      }
      try {
        // electron-packager may hardlink/clone files into buildPath for speed,
        // so the staged package.json can share an inode with the source. Writing
        // through that path mutates the working tree. Unlink first to force a
        // fresh inode, then write the modified copy.
        const pkgPath = path.join(buildPath, 'package.json')
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        pkg.upgrade = process.env.UPGRADE_KEY
        fs.unlinkSync(pkgPath)
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
        callback()
      } catch (err) {
        callback(err)
      }
    },
  ],
  ignore: [
    /^\/\.claude($|\/)/,
    /\/\.github($|\/)/,
    /^\/appling($|\/)/,
    /^\/seed-host($|\/)/,
    /^\/test($|\/)/,
    /^\/research-.*\.md$/,
    /^\/scripts($|\/)/,
    // src/renderer is bundled into assets/dist by esbuild; the .tsx sources
    // don't ship. src/{main,preload,worker,shared} are part of the runtime
    // and must stay.
    /^\/src\/renderer($|\/)/,
    /^\/tailwind\.config\.js$/,
    /^\/tsconfig\.json$/,
    /^\/forge\.config\.js$/,
    // Top-level docs and dotfiles. LICENSE intentionally kept for legal
    // compliance; everything else is internal noise that has no business
    // shipping to end users.
    /^\/[^/]+\.md$/,
    /^\/\.env(\..*)?$/,
    /^\/\.gitignore$/,
    /^\/\.gitattributes$/,
    /^\/\.editorconfig$/,
    /^\/\.npmrc$/,
    /^\/\.prettierrc.*$/,
    /^\/\.eslintrc.*$/,
    // Sourcemaps from our own build. The `--sources-content=false` flag
    // already strips embedded source code from the .map; this also keeps
    // the file itself out of the bundle so we don't ship 1.8 MB of
    // path-only sourcemap data.
    /^\/assets\/dist\/.*\.map$/,
    // resources/ is mostly package-time inputs read from the source tree by
    // forge makers (DMG layout, MSIX manifest, AppImage staging) — none
    // of it is read at runtime. Keep only the per-platform Notification
    // icons (resources/{darwin/icon.icns,win32/icon.ico,linux/icon.png}).
    /^\/resources\/darwin\/dmg($|\/)/,
    /^\/resources\/darwin\/entitlements\.plist$/,
    /^\/resources\/win32\/AppxManifest\.xml$/,
    /^\/resources\/win32\/msix-assets($|\/)/,
    /^\/resources\/linux\/AppRun$/,
    /^\/resources\/linux\/icons($|\/)/,
    // Standalone subprojects and dev-only top-level entries — never loaded by
    // the app at runtime. cloudflare-worker ships its own 286 MB node_modules
    // otherwise. feature-flags.json IS read at runtime, so it stays.
    /^\/cloudflare-worker($|\/)/,
    /^\/worktrees($|\/)/,
    /^\/eslint\.config\.[cm]?js$/,
    /^\/renovate\.json$/,
    /^\/package-lock\.json$/,
    /\.DS_Store$/,
    // Non-runtime cruft inside shipped node_modules. Bare loads .js/.json/.node/
    // .bare from disk, so only strip what no runtime reads: sourcemaps, type
    // declarations, TS sources, and doc markdown (LICENSE/NOTICE kept for
    // compliance). No dir-name patterns: test/example dirs are devDep-only in
    // the shipped tree (pruned already) so they'd add runtime risk for ~0 gain.
    /\/node_modules\/.*\.map$/,
    /\/node_modules\/.*\.d\.[cm]?ts$/,
    /\/node_modules\/.*\.tsx?$/,
    /\/node_modules\/.*\/(README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)(\.(md|markdown|txt|rst))?$/i,
  ],
}

if (process.env.APPLE_SIGNING_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.APPLE_SIGNING_IDENTITY,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'resources', 'darwin', 'entitlements.plist'),
      }),
    },
  }
  if (process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_ID_PASSWORD) {
    packagerConfig.osxNotarize = {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_ID_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    }
  }
}

module.exports = {
  packagerConfig,

  hooks: {
    // Fail fast if UPGRADE_KEY is unset. Runs only for package/make — `start`
    // doesn't need an upgrade key (the OTA path isn't exercised in dev). The
    // actual injection into the asar's package.json happens in
    // packagerConfig.afterCopy; this hook is a friendly pre-flight check.
    prePackage: async () => {
      if (!process.env.UPGRADE_KEY) {
        throw new Error(
          'UPGRADE_KEY env var is required for electron-forge package/make. ' +
          'In CI it is set by the "Resolve UPGRADE_KEY for channel" step in build-electron.yml. ' +
          'For local builds, set it explicitly: UPGRADE_KEY=pear://<key> npm run make:<platform>'
        )
      }
    },

    preMake: async () => {
      const out = path.join(__dirname, 'out', 'make')
      try { fs.rmSync(out, { recursive: true, force: true }) } catch {}

      if (process.platform === 'darwin') {
        const mountPoint = `/Volumes/${appName}`
        if (fs.existsSync(mountPoint)) {
          const { execSync } = require('child_process')
          try {
            execSync(`hdiutil detach ${JSON.stringify(mountPoint)} -force`, { stdio: 'ignore' })
            console.log('Detached stale DMG mount at', mountPoint)
          } catch {}
        }
      }

      const manifest = path.join(__dirname, 'resources', 'win32', 'AppxManifest.xml')
      if (fs.existsSync(manifest)) {
        const m = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.?(\d+))?$/i)
        let four = '0.0.0.0'
        if (m) {
          const [, major, minor, patch, pre] = m
          const rev = pre ? (parseInt(pre, 10) % 65536).toString() : '65535'
          four = `${major}.${minor}.${patch}.${rev}`
        }
        const xml = fs.readFileSync(manifest, 'utf-8')
        const updated = xml.replace(/Version="[^"]*"/, `Version="${four}"`)
        fs.writeFileSync(manifest, updated)
        console.log('MSIX version set to', four)
      }
    },

    postMake: async (_forgeConfig, results) => {
      for (const result of results) {
        if (result.platform === 'darwin') {
          for (const artifact of result.artifacts) {
            if (artifact.endsWith('.dmg')) hideDmgInternals(artifact)
          }
        }
        if (result.platform !== 'win32') continue
        for (let i = 0; i < result.artifacts.length; i++) {
          const artifact = result.artifacts[i]
          if (!artifact.endsWith('.msix')) continue
          const dir = path.join(__dirname, 'out', `${appName}-win32-${result.arch}`)
          fs.mkdirSync(dir, { recursive: true })
          const dest = path.join(dir, path.basename(artifact))
          if (artifact !== dest) {
            fs.renameSync(artifact, dest)
            result.artifacts[i] = dest
          }
        }
      }
      if (isWindows) {
        const stage = path.join(__dirname, 'out', 'make')
        try { fs.rmSync(stage, { recursive: true, force: true }) } catch {}
      }
    },
  },

  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: appName,
        icon: path.join(__dirname, 'resources', 'darwin', 'dmg', 'VolumeIcon.icns'),
        background: path.join(__dirname, 'resources', 'darwin', 'dmg', 'background@2x.png'),
        iconSize: 100,
        format: 'ULFO',
        overwrite: true,
        contents: (opts) => [
          { x: 140, y: 170, type: 'file', path: opts.appPath },
          { x: 400, y: 170, type: 'link', path: '/Applications' },
        ],
        additionalDMGOptions: {
          window: {
            size: { width: 540, height: 390 },
          },
        },
      },
    },
    {
      name: '@electron-forge/maker-msix',
      platforms: ['win32'],
      config: {
        appManifest: path.join(__dirname, 'resources', 'win32', 'AppxManifest.xml'),
        // packageAssets is copied into the MSIX root's `assets/` folder by
        // electron-windows-msix; AppxManifest.xml's Logo / Square*Logo paths
        // resolve against it. Without this, the maker copies its own placeholder
        // assets and the manifest's `assets\*Logo.png` paths fail to resolve,
        // causing Windows to render the default app icon.
        packageAssets: path.join(__dirname, 'resources', 'win32', 'msix-assets'),
        windowsKitVersion: getWindowsKitVersion(),
        sign: false,
      },
    },
  ],

  plugins: [
    { name: 'electron-forge-plugin-universal-prebuilds', config: {} },
    { name: 'electron-forge-plugin-prune-prebuilds', config: {} },
  ],
}
