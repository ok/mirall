// Named link profiles for the adversarial-network flow tests. Pass one to a peer via
// launchPeer flags:  launchPeer(t, { ..., flags: { ...v2flags(), netImpair: LINKS.transcontinental } }).
//
// `netImpair` is a TEST-ONLY runtime-config knob applied per swarm connection in
// swarm.js (applyNetImpairment); production never sets it. It shapes THIS peer's outbound
// app frames in place (no Duplex wrapping) — set it on both peers for a symmetric bad link,
// or on one for an asymmetric one.
//   latencyMs / jitterMs      — delay every outbound frame by latency + rand(jitter), FIFO-ordered
//                               (models round-trip latency and loss-retransmit spikes)
//   flapEveryMs / flapJitterMs — after this long, destroy the live connection so Hyperswarm
//                               re-dials (models a flaky link: reconnect churn + state re-sync)
export const LINKS = {
  // High round-trip latency with jitter — the cross-continent "Egypt session" shape.
  transcontinental: { latencyMs: 200, jitterMs: 120 },
  // Very high latency + heavy jitter — a satellite / heavily congested link.
  satellite: { latencyMs: 500, jitterMs: 300 },
  // A flaky link that drops the connection every ~8-11s, forcing reconnects, with moderate latency.
  flaky: { latencyMs: 100, jitterMs: 80, flapEveryMs: 8000, flapJitterMs: 3000 },
  // The worst realistic case: real latency AND periodic drops.
  brutal: { latencyMs: 200, jitterMs: 150, flapEveryMs: 8000, flapJitterMs: 4000 },
}
