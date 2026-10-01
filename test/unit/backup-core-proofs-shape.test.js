import test from 'brittle'
import c from 'compact-encoding'
import b4a from 'b4a'
import hypercoreMessages from 'hypercore/lib/messages.js'
import merkleTree from 'hypercore/lib/merkle-tree.js'
import Core from 'hypercore/lib/core.js'

// The two hypercore internals the backup's proof records rest on. A hypercore release that moves
// either fails here, before a backup could be written that no build can read back.
test('the replication data message round-trips a block proof', (t) => {
  const { wire } = hypercoreMessages
  t.is(typeof wire?.data?.encode, 'function')
  const proof = {
    request: 0,
    fork: 0,
    block: { index: 3, value: b4a.from('block'), nodes: [{ index: 6, size: 5, hash: b4a.alloc(32, 1) }] },
    hash: null,
    seek: null,
    upgrade: null,
    manifest: null,
  }
  const back = c.decode(wire.data, c.encode(wire.data, proof))
  t.is(back.block.index, 3)
  t.alike(back.block.value, b4a.from('block'))
  t.is(back.block.nodes[0].index, 6)
})

test('the merkle tree still counts the nodes a block proof needs', (t) => {
  const { MerkleTree } = merkleTree
  t.is(typeof MerkleTree?.maxMissingNodes, 'function')
  t.is(typeof MerkleTree.maxMissingNodes(2 * 5, 10), 'number')
})

test('the merkle tree reads roots, and a core can verify and commit a reorg', (t) => {
  const { MerkleTree } = merkleTree
  t.is(typeof MerkleTree.getRoots, 'function')
  t.is(typeof Core.prototype.verifyReorg, 'function')
  t.is(typeof Core.prototype.reorg, 'function')
})
