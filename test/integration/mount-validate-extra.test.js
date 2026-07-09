import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { validateMountPathSync } from '../../src/shared/folders/mount-validate.js'
import { getStoragePath } from '../../src/shared/core/store.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'

const codeOf = (fn) => { try { fn(); return null } catch (e) { return e.code } }

test('rejects a mount inside the app-data (store) directory', async (t) => {
  await freshPeer(t)
  const inside = path.join(getStoragePath(), 'mnt')
  fs.mkdirSync(inside, { recursive: true })
  t.is(
    codeOf(() => validateMountPathSync(inside, 'owned-folder', [])),
    ErrorCodes.MOUNT_FORBIDDEN_APP_DATA,
  )
})
