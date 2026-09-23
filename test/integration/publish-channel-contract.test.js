import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { publishChannelFor } from '../../src/shared/folders/publish-service.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'

// The members the boot rehydrate and the presence sweep drive on every own share's channel.
const MAINTENANCE = ['presentAt', 'rehydrate', 'retireGone']

test('both publish channels carry the maintenance surface', async (t) => {
  await freshPeer(t)
  for (const [kind, shareId] of [['loose', LOOSE_SHARE_ID], ['folder', 'any-folder-share']]) {
    const channel = publishChannelFor(shareId)
    t.ok(channel, `a ${kind} channel is registered`)
    for (const name of MAINTENANCE) t.is(typeof channel[name], 'function', `${kind} implements ${name}()`)
    t.ok(channel.contentRoot === undefined || typeof channel.contentRoot === 'function', `${kind} contentRoot is absent or a resolver`)
  }
})
