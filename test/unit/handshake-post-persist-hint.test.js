import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const swarmSrc = readFileSync(path.join(here, '..', '..', 'src', 'shared', 'transfer', 'swarm.js'), 'utf8')

// The handshake's early event:files-updated fires BEFORE persistHandshakeMember commits the
// peer's looseCatalogKey — a files view re-deriving on it can read the roster pre-persist,
// miss the peer's loose catalog, and never register the append watch ("Nothing shared yet"
// until an unrelated refresh). The members poke is post-persist but members-scoped, which
// useFiles ignores. This pins the post-persist files re-hint next to that poke.
test('REGRESSION (FIX-B1: handleHandshake re-emits a files hint after the member record persists)', (t) => {
  const persistAt = swarmSrc.indexOf('await persistHandshakeMember(')
  t.ok(persistAt > -1, 'persist call found')
  const after = swarmSrc.slice(persistAt, persistAt + 1600)
  const pokeAt = after.indexOf('membersPoke.poke(spaceId)')
  t.ok(pokeAt > -1, 'post-persist members poke found')
  const filesHint = after.slice(pokeAt).indexOf("emit('event:files-updated', { spaceId })")
  t.ok(filesHint > -1, 'a files-updated hint follows the post-persist members poke')
})
