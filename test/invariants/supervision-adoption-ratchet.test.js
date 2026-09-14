import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { parseSource, forEachNode } from '../helpers/ast-scan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) } else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// The population, measured by a parser rather than by a grep: a class is a class however the
// `extends` clause is spelled or wrapped, and a method is declared or it is not. Every subsystem
// class in src/ is read this way, with the methods its body declares.
function subsystemClasses() {
  const found = new Map()
  for (const file of walk(path.join(root, 'src'))) {
    const { ast, visitorKeys } = parseSource(readFileSync(file, 'utf8'), file)
    forEachNode(ast, visitorKeys, (node) => {
      if (node.type !== 'ClassDeclaration') return
      if (node.superClass?.type !== 'Identifier' || node.superClass.name !== 'Subsystem') return
      const methods = new Set()
      for (const member of node.body.body) {
        if (member.type === 'MethodDefinition' && member.key.type === 'Identifier') methods.add(member.key.name)
      }
      found.set(node.id.name, { file: path.relative(root, file), methods })
    })
  }
  return found
}

// Every live-tier subsystem either declares supervisable units or is listed below with the reason
// it does not. The list is the declaration: adding a subsystem forces a line and adopting one
// moves a line. It is NOT a floor to be raised — a new entry needs a sentence a reviewer can
// disagree with.
const SUPERVISED = [
  'ForeignMirrors', 'MemberViews', 'OwnedFolders', 'PublishService', 'Swarm',
]

const UNSUPERVISED = {
  OverlayBackend: 'every fetch is bounded by the chunk scheduler lease; no keyed pass of its own',
  EchoGuardPurge: 'a bounded periodic purge, with no pass held per key',
  PeerWatch: 'per-peer sweeps settle or reject; nothing coalesces onto a held promise',
  ContentSwarm: 'no pass of its own — it attaches the overlay to a socket',
  MountsRuntime: 'bounded periodic probes since its hand-built mirror probe was removed',
  Sweeps: 'bounded periodic sweeps, each of which settles or throws',
  Supervisor: 'it is the supervisor, and it reports its own liveness through health()',
}

// Spelled out rather than derived, and that is deliberate: boot.js starting a subsystem on the
// durable tier is the decision that exempts it, and moving one between tiers should break this.
const DURABLE = [
  'Store', 'SpaceKeysVault', 'ProfileBee', 'SpacesBee', 'DownloadsBee', 'PendingTransfersBee',
  'MountsBee', 'IntentsBee', 'AuditLog', 'ServeLedger', 'Catalogs', 'SpaceDrives',
]

test('every subsystem listed as supervised declares units and can recover one', (t) => {
  const found = subsystemClasses()
  for (const name of SUPERVISED) {
    const cls = found.get(name)
    t.ok(cls, `${name} is a subsystem`)
    t.ok(cls?.methods.has('supervise'), `${name} declares supervisable units`)
    t.ok(cls?.methods.has('recover'), `${name} can recover one`)
  }
})

test('every exempt subsystem states a reason, and declares no units', (t) => {
  const found = subsystemClasses()
  for (const [name, reason] of Object.entries(UNSUPERVISED)) {
    t.ok(reason.length > 20, `${name}'s exemption states a reason a reviewer can disagree with`)
    t.absent(found.get(name)?.methods.has('supervise'),
      `${name} declares no units — adopting it means moving its line, not keeping both`)
  }
})

test('no subsystem is missing from either list', (t) => {
  const found = [...subsystemClasses().keys()]
  const accounted = new Set([...SUPERVISED, ...Object.keys(UNSUPERVISED), ...DURABLE])
  t.alike(found.filter((n) => !accounted.has(n)), [],
    'a new subsystem must declare units or state why it has none')
  t.alike([...accounted].filter((n) => !found.includes(n)), [],
    'and a list entry that no longer names a subsystem is stale')
})

test('the durable tier declares nothing supervisable', (t) => {
  const found = subsystemClasses()
  for (const name of DURABLE) {
    t.absent(found.get(name)?.methods.has('supervise'),
      `${name} is store-backed: closing one of its handles would close every session with it`)
  }
})
