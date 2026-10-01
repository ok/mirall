// Every core in the store a backup covers, with the role it plays. Own bees are recognised by the
// discovery key their name derives from the master secret, so nothing is opened to classify; a core
// with a secret key nobody names is still ours and is kept as `own`, and everything else belongs to a
// peer. The overlay's local index (found by its namespace's aliases, so it is recognised even while
// the overlay is down), a local bee's rewrite scratch and the plaintext predecessors of migrated cores
// are rebuilt or superseded, never restored.
import b4a from 'b4a'
import { LOCAL_BEE_NAMES, beeDiscoveryKeyHex, localBeeDiscoveryKeys } from '../../core/store.js'
import { listSpaces } from '../../spaces/space.js'
import { catalogNameForSpace, plaintextCatalogName } from '../../shares/own-catalog.js'
import { PROFILE_BEE } from '../../core/restore-hold.js'
import { OVERLAY_NAMESPACE, OVERLAY_NAMESPACE_ENC } from '../../transfer/overlay/overlay-namespaces.js'

export const CORE_ROLE = Object.freeze({
  PROFILE: 'profile',
  LOCAL_BEE: 'local-bee',
  INTENTS: 'intents',
  OWN_CATALOG: 'own-catalog',
  OWN: 'own',
  PEER: 'peer',
  SKIP: 'skip',
})

const INTENTS_BEE = 'intents'

async function knownRoles(store) {
  const roles = new Map()
  const name = (dk, role, extra = {}) => { if (dk) roles.set(dk, { role, name: null, spaceId: null, ...extra }) }
  name(await beeDiscoveryKeyHex(PROFILE_BEE), CORE_ROLE.PROFILE, { name: PROFILE_BEE })
  name(await beeDiscoveryKeyHex(INTENTS_BEE), CORE_ROLE.INTENTS, { name: INTENTS_BEE })
  for (const bee of LOCAL_BEE_NAMES) {
    const [current, ...superseded] = await localBeeDiscoveryKeys(bee)
    name(current, CORE_ROLE.LOCAL_BEE, { name: bee })
    for (const dk of superseded) name(dk, CORE_ROLE.SKIP)
  }
  for (const space of await listSpaces()) {
    const catalog = catalogNameForSpace(space.spaceId, space)
    name(await beeDiscoveryKeyHex(plaintextCatalogName(space.spaceId, space)), CORE_ROLE.SKIP)
    name(await beeDiscoveryKeyHex(catalog), CORE_ROLE.OWN_CATALOG, { name: catalog, spaceId: space.spaceId })
  }
  for (const dk of await overlayDiscoveryKeys(store)) name(dk, CORE_ROLE.SKIP)
  return roles
}

async function overlayDiscoveryKeys(store) {
  const dks = []
  for (const namespace of [OVERLAY_NAMESPACE, OVERLAY_NAMESPACE_ENC]) {
    const session = store.namespace(namespace)
    try {
      for await (const { discoveryKey } of store.storage.createAliasStream(session.ns)) dks.push(b4a.toString(discoveryKey, 'hex'))
    } finally {
      await session.close()
    }
  }
  return dks
}

export async function listCores(store) {
  const roles = await knownRoles(store)
  const cores = []
  for await (const discoveryKey of store.list()) {
    const dk = b4a.toString(discoveryKey, 'hex')
    const known = roles.get(dk)
    if (known?.role === CORE_ROLE.SKIP) continue
    const auth = await store.getAuth(discoveryKey)
    if (!auth?.key) continue
    const role = known?.role ?? (auth.keyPair?.secretKey ? CORE_ROLE.OWN : CORE_ROLE.PEER)
    cores.push({ dk, key: b4a.toString(auth.key, 'hex'), role, name: known?.name ?? null, spaceId: known?.spaceId ?? null })
  }
  return cores
}
