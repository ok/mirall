// The at-rest secret files and where each may live. A reader looks inside the store directory first,
// then beside it; a file in neither place is created beside it. Writers stay beside the store until
// every build that shares a store reads the inside location: a build that finds no identity.enc where
// it looks mints a different identity over the existing data.
export const SECRET_FILE = Object.freeze({
  IDENTITY: 'identity.enc',
  KEK: 'kek.enc',
  SPACE_KEYS: 'space-keys.enc',
  RELAY_TICKET: 'relay-ticket.enc',
})

/**
 * @param {string} storagePath
 * @param {string} name
 * @param {{ join: (...parts: string[]) => string, dirname: (p: string) => string, exists: (p: string) => boolean }} fs
 * @returns {string}
 */
export function resolveSecretFile(storagePath, name, { join, dirname, exists }) {
  const inside = join(storagePath, name)
  return exists(inside) ? inside : join(dirname(storagePath), name)
}
