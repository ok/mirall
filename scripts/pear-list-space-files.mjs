// scripts/pear-list-space-files.mjs — read-only inspector. Quit Mirall before running.
//
// Usage:
//   node scripts/pear-list-space-files.mjs               # all spaces, local drive
//   node scripts/pear-list-space-files.mjs <spaceId>     # one space, local drive
//   MIRALL_STORAGE=/tmp/mirall-snap node scripts/pear-list-space-files.mjs
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import os from 'os'
import path from 'path'

const dir = process.env.MIRALL_STORAGE
  || path.join(os.homedir(), 'Library/Application Support/Mirall/app-storage')
const onlySpaceId = process.argv[2] || null

const store = new Corestore(dir)
await store.ready()

const spacesCore = store.get({ name: 'spaces-meta' })
await spacesCore.ready()
const spacesBee = new Hyperbee(spacesCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
await spacesBee.ready()

const spaces = []
for await (const { key, value } of spacesBee.createReadStream({ gte: 'space/', lt: 'space0' })) {
  spaces.push({ spaceId: key.replace('space/', ''), ...value })
}

if (spaces.length === 0) {
  console.log('No spaces found in', dir)
  await store.close()
  process.exit(0)
}

let grandTotalBytes = 0
let grandTotalFiles = 0

for (const space of spaces) {
  if (onlySpaceId && space.spaceId !== onlySpaceId) continue

  const drive = new Hyperdrive(store.namespace('space-drive-' + space.spaceId))
  await drive.ready()

  console.log('\n=== Space:', space.name, `(${space.spaceId}) ===`)
  console.log('  driveKey:', b4a.toString(drive.key, 'hex'))
  console.log('  version :', drive.version)
  console.log('  topic   :', space.topic)
  console.log('  members :', (space.members || []).length)
  console.log('')

  let count = 0
  let totalBytes = 0
  for await (const entry of drive.list('/')) {
    const blob = entry.value?.blob
    const size = blob?.byteLength ?? 0
    const hash = entry.value?.metadata?.hash ?? '(none)'
    console.log(
      [
        entry.key.padEnd(48),
        String(size).padStart(12),
        hash.slice(0, 16) + (hash.length > 16 ? '…' : ''),
        entry.value?.executable ? 'exec' : '',
      ].join('  ')
    )
    count++
    totalBytes += size
  }

  console.log(`\n  ${count} file(s), ${formatBytes(totalBytes)}`)
  grandTotalFiles += count
  grandTotalBytes += totalBytes

  await drive.close()
}

console.log('\n────────')
console.log(`Total across listed spaces: ${grandTotalFiles} file(s), ${formatBytes(grandTotalBytes)}`)

await store.close()

function formatBytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KiB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MiB'
  return (n / 1024 ** 3).toFixed(2) + ' GiB'
}
