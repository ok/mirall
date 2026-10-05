// A core's range as self-verifying records, and the way back in. A record is hypercore's own
// replication `data` message, so applying one is verified exactly like a block from a peer: a changed
// block or a gap in the chain is refused by the merkle tree, and an encrypted core's blocks stay
// ciphertext. The only module that reaches into hypercore's internals (the wire codec, the merkle
// roots and node count, and the core's reorg); test/unit/backup-core-proofs-shape.test.js pins them.
import c from 'compact-encoding'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import hypercoreMessages from 'hypercore/lib/messages.js'
import merkleTree from 'hypercore/lib/merkle-tree.js'
import { AppError } from '../../core/errors.js'
import { CODES } from '../../contract/errors.js'

const { wire } = hypercoreMessages
const { MerkleTree } = merkleTree

// Proofs are built this many at a time; their order in the output is kept.
const PROOF_BATCH = 64

const corrupt = (why) => new AppError(CODES.BACKUP_CORRUPT, `backup: ${why}`)

// The tree hash at `length`, from the stored roots: unlike the session's treeHash it never fetches
// the last block, which a peer's core may not hold.
export async function rootTreeHash(snap, length) {
  return b4a.toString(crypto.tree(await MerkleTree.getRoots(snap.state, length)), 'hex')
}

async function blockRecord(snap, index, to) {
  const proof = await snap.proof({ block: { index, nodes: MerkleTree.maxMissingNodes(2 * index, to) } })
  proof.request = 0
  proof.manifest = null
  return c.encode(wire.data, proof)
}

// One upgrade proof to `to`, then a proof per block this core holds in [from, to). A block the core
// does not hold is left out: a peer's core is backed up as far as this device has it.
export async function* proofRecords(snap, from, to) {
  const upgrade = await snap.proof({ upgrade: { start: from, length: to - from } })
  upgrade.request = 0
  upgrade.manifest = from === 0 ? snap.manifest : null
  yield c.encode(wire.data, upgrade)
  for (let start = from; start < to; start += PROOF_BATCH) {
    const indexes = []
    for (let index = start; index < Math.min(to, start + PROOF_BATCH); index++) {
      if (await snap.has(index)) indexes.push(index)
    }
    yield * await Promise.all(indexes.map((index) => blockRecord(snap, index, to)))
  }
}

// A fresh core sits at fork 0, so the first record of a core captured on a later fork is applied the
// way replication follows a fork: verified as a reorg onto that fork, then committed.
export async function applyRecord(core, record) {
  let proof
  try {
    proof = c.decode(wire.data, record)
  } catch {
    throw corrupt('a record does not decode')
  }
  try {
    if (proof.upgrade && proof.fork !== core.fork) {
      if (await core.core.reorg(await core.core.verifyReorg(proof))) return
    } else if (await core.applyProof(proof)) {
      return
    }
  } catch (err) {
    throw corrupt(`a record was refused (${err.code || err.message})`)
  }
  throw corrupt('a record was refused')
}
