import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// The store lives at the real %APPDATA%\mirall only while the manifest opts out
// of filesystem write virtualization. Windows honours that opt-out, and the
// unvirtualizedResources capability behind it, from 1903 (build 18362). Below
// that the desktop6 element is ignored (its namespace is ignorable) and writes
// land in the package's private LocalCache, so a process outside the package
// would resolve a different store. MinVersion must therefore stay at 18362 or
// above for as long as the opt-out is declared.

const OPT_OUT_MIN_BUILD = 18362

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = readFileSync(path.join(here, '..', '..', 'resources', 'win32', 'AppxManifest.xml'), 'utf8')

test('MSIX MinVersion covers the filesystem write-virtualization opt-out', (t) => {
  const optOut = /<desktop6:FileSystemWriteVirtualization>\s*disabled\s*<\/desktop6:FileSystemWriteVirtualization>/.test(manifest)
  t.ok(optOut, 'the manifest disables filesystem write virtualization')

  const families = [...manifest.matchAll(/<TargetDeviceFamily\b[^>]*\bMinVersion="10\.0\.(\d+)\.\d+"/g)]
  t.ok(families.length > 0, 'the manifest declares a TargetDeviceFamily MinVersion')
  for (const [tag, build] of families) {
    t.ok(Number(build) >= OPT_OUT_MIN_BUILD, `MinVersion build ${build} >= ${OPT_OUT_MIN_BUILD}: ${tag}`)
  }
})
