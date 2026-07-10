// TEST-ONLY link shaper (runtime-config `netImpair`; production never sets it). Reproduces bad
// real-world links in flow tests by degrading a connection in place — no Duplex wrapping, so the
// socket's Noise/peer properties survive. Latency delays every outbound app frame (both peers
// impairing → a symmetric high-RTT link); flap periodically destroys the live connection so
// Hyperswarm re-dials (the connection handler re-runs and re-impairs the fresh socket). Applied
// on both the control and content planes so an impaired-link test shapes the bulk path too.
import { getNetImpair } from '../core/runtime-config.js'

export function applyNetImpairment(socket) {
  const cfg = getNetImpair()
  if (!cfg) return
  const latencyMs = cfg.latencyMs | 0
  const jitterMs = cfg.jitterMs | 0
  if (latencyMs > 0 || jitterMs > 0) {
    const realWrite = socket.write.bind(socket)
    // Ordered release queue: this is a RELIABLE, in-order stream (Protomux framing), so frames
    // MUST leave in FIFO order — independent per-frame timers with jitter would reorder and
    // corrupt it. Each frame's release time is max(now+latency+jitter, previous release).
    const q = []
    let pumping = false
    const pump = () => {
      if (pumping) return
      pumping = true
      const step = () => {
        while (q.length && q[0].at <= Date.now()) { const it = q.shift(); try { realWrite(it.data, ...it.rest) } catch {} }
        if (!q.length) { pumping = false; return }
        const timer = setTimeout(step, Math.max(0, q[0].at - Date.now()))
        timer.unref?.()
      }
      step()
    }
    socket.write = (data, ...rest) => {
      const delay = latencyMs + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0)
      const prevAt = q.length ? q[q.length - 1].at : 0
      q.push({ data, rest, at: Math.max(Date.now() + delay, prevAt) })
      pump()
      return true
    }
    socket.once('close', () => { q.length = 0 })
  }
  if ((cfg.flapEveryMs | 0) > 0) {
    const jitter = cfg.flapJitterMs | 0
    const timer = setTimeout(() => { try { socket.destroy() } catch {} },
      cfg.flapEveryMs + (jitter > 0 ? Math.floor(Math.random() * jitter) : 0))
    timer.unref?.()
    socket.once('close', () => clearTimeout(timer))
  }
}
