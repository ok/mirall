import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, listRelPaths } from '../helpers/owned.js'
import { stopOwnedFolder } from '../../src/shared/folders/owned-folders.js'
import { runPublishPass } from '../../src/shared/folders/owned-pass.js'
import { onFsEvent } from '../../src/shared/folders/owned-watcher.js'
import { until } from '../helpers/bare-poll.js'

const waitUntil = (pred, ms = 6000) => until(pred, ms, { interval: 100 })

// Mirrors the report: top-level files already published, then the SAME files are
// copied into a new subfolder (identical content) and arrive as a burst of
// watcher add events.
test('copying existing files into a subfolder publishes them all', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  const names = ['garden-1.jpg', 'garden-2.jpg', 'lake-day.jpg']
  names.forEach((n, i) => fs.writeFileSync(path.join(mountPath, n), 'distinct-content-' + i))
  await runPublishPass(spaceId, share.id, mountPath, [])

  const sub = path.join(mountPath, 'subfolder')
  fs.mkdirSync(sub, { recursive: true })
  names.forEach((n, i) => fs.writeFileSync(path.join(sub, n), 'distinct-content-' + i))

  await Promise.all(names.map((n) =>
    onFsEvent(spaceId, share.id, 'add', 'subfolder/' + n, path.join(sub, n)),
  ))

  const rel = await listRelPaths(share, spaceId)
  t.alike(rel, [
    'garden-1.jpg', 'garden-2.jpg', 'lake-day.jpg',
    'subfolder/garden-1.jpg', 'subfolder/garden-2.jpg', 'subfolder/lake-day.jpg',
  ])
})

// REGRESSION (FIX-WATCHER-MISS): chokidar can drop an add when files land in a
// new subfolder together, leaving a copied file unpublished. The catch-up
// reconcile triggered by the events that DID fire must publish the straggler.
test('a dropped watcher add is recovered by the catch-up reconcile', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const sub = path.join(mountPath, 'subfolder')
  fs.mkdirSync(sub, { recursive: true })
  const names = ['garden-1.jpg', 'garden-2.jpg', 'lake-day.jpg']
  names.forEach((n, i) => fs.writeFileSync(path.join(sub, n), 'content-' + i))

  // The watcher delivers only two of the three adds (garden-2 is dropped).
  await onFsEvent(spaceId, share.id, 'add', 'subfolder/garden-1.jpg', path.join(sub, 'garden-1.jpg'))
  await onFsEvent(spaceId, share.id, 'add', 'subfolder/lake-day.jpg', path.join(sub, 'lake-day.jpg'))

  t.absent((await listRelPaths(share, spaceId)).includes('subfolder/garden-2.jpg'), 'straggler not yet published')

  const recovered = await waitUntil(async () =>
    (await listRelPaths(share, spaceId)).includes('subfolder/garden-2.jpg'))
  t.ok(recovered, 'catch-up reconcile published the dropped file')
})
