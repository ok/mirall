import test from 'brittle'
import path from 'path'
import { SECRET_FILE, resolveSecretFile } from '../../src/shared/contract/secret-files.js'

const STORAGE = path.join('/data', 'mirall', 'app-storage')

function resolver(existing) {
  const set = new Set(existing)
  return { join: path.join, dirname: path.dirname, exists: (p) => set.has(p) }
}

test('every secret file resolves inside the store when it is there', (t) => {
  for (const name of Object.values(SECRET_FILE)) {
    const inside = path.join(STORAGE, name)
    t.is(resolveSecretFile(STORAGE, name, resolver([inside, path.join('/data', 'mirall', name)])), inside, name)
  }
})

test('a secret file inside nowhere resolves beside the store, where writers create it', (t) => {
  for (const name of Object.values(SECRET_FILE)) {
    t.is(resolveSecretFile(STORAGE, name, resolver([])), path.join('/data', 'mirall', name), name)
  }
})

test('a file only beside the store stays beside it', (t) => {
  const beside = path.join('/data', 'mirall', SECRET_FILE.IDENTITY)
  t.is(resolveSecretFile(STORAGE, SECRET_FILE.IDENTITY, resolver([beside])), beside)
})

test('the file names are fixed', (t) => {
  t.alike({ ...SECRET_FILE }, {
    IDENTITY: 'identity.enc',
    KEK: 'kek.enc',
    SPACE_KEYS: 'space-keys.enc',
    RELAY_TICKET: 'relay-ticket.enc',
  })
})
