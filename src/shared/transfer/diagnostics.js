import { shortId, makeAliaser } from '../core/diagnostics-redact.js'

export const DIAGNOSTICS_SCHEMA = 1

// Shapes, not identities. Everything a connectivity diagnosis needs — did host consensus
// form, is the port 0, did it change, how many dials opened — is answerable without the
// actual IP, the real keys, or space names.
export function buildDiagnostics(ctx, redact = true) {
  const { status, history, env, counters, peerSamples } = ctx
  const topicAlias = makeAliaser('t')
  const samples = peerSamples.map((peer) => ({
    peer: redact ? shortId(peer.publicKey) : peer.publicKey,
    topic: redact ? topicAlias(peer.topic) : peer.topic,
    attempts: peer.attempts,
    proven: peer.proven,
  }))

  return {
    schema: DIAGNOSTICS_SCHEMA,
    generatedAt: Date.now(),
    redacted: redact,
    reference: env.installId ? env.installId.slice(0, 8) : null,

    app: { version: env.appVersion, channel: env.channel, build: env.packaged ? 'packaged' : 'source' },
    system: { platform: env.platform, release: env.release, arch: env.arch },

    verdict: { current: status.reachability, history },

    network: {
      dhtReady: status.dhtReady,
      announced: status.announced,
      readyAfterMs: counters.readyAt > 0 && counters.bootedAt > 0 ? counters.readyAt - counters.bootedAt : null,
      publicHostKnown: status.address.publicHost !== null,
      publicHostChanged: counters.hostChangeCount > 0,
      // publicPort === 0 IS the symmetric-NAT finding and identifies nobody, so it is
      // never redacted.
      publicPort: status.address.publicPort,
      localPortStable: counters.localPortStable,
      firewalled: status.nat.firewalled,
      randomized: status.nat.randomized,
      ephemeral: status.nat.ephemeral,
      routingTableSize: status.routing.tableSize,
      bootstrapCount: status.routing.bootstrap.length,
      health: status.dhtHealth,
      ...(redact ? {} : {
        publicHost: status.address.publicHost,
        publicKey: status.identity.publicKey,
        nodeId: status.identity.nodeId,
        bootstrap: status.routing.bootstrap,
      }),
    },

    peers: {
      discovered: status.peerReach.discovered,
      connected: status.peerReach.connected,
      exhausted: status.peerReach.exhausted,
      dials: status.stats.connects.client,
      inbound: status.stats.connects.server,
      bannedPeers: status.stats.bannedPeers,
      samples,
    },

    canary: status.canary,
    liveness: status.liveness,
    relaying: status.stats.relaying,

    spaces: {
      count: status.topics,
      topics: samples.map((sample) => sample.topic).filter((topic) => topic !== null),
    },
  }
}
