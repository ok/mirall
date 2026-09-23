// The two frames that decide whether the rest of the wire is spoken at all: a client's
// introduction, and the host's boot payload. Split from the router because the router owns what a
// REQUEST means; this owns the one exchange that has to complete before any request is honoured.
import { FRAME, IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED } from '../contract/ipc-frames.js'
import { checkHello, refusalMessage } from '../contract/hello.js'
import { CODES } from '../contract/errors.js'
import { AppError } from './errors.js'
import { fields } from './logger.js'

// `isPrimary` rather than the client itself: the spawn pipe's client is attached after the router
// body has run, and only a frame arriving on it can ask the question.
export function createHandshake({ log, events, clients, isPrimary }) {
  let bootstrapResolve
  let bootstrapReject
  const bootstrapPromise = new Promise((resolve, reject) => {
    bootstrapResolve = resolve
    bootstrapReject = reject
  })
  // A rejection nobody is awaiting yet is an unhandled rejection the crash backstop would count.
  // The single production awaiter attaches before any frame can arrive, but a test router that
  // never awaits must not take the process down with it.
  bootstrapPromise.catch(() => {})

  // The version was settled by the hello, so the bootstrap is now only the payload. Resolver and
  // rejecter are nulled together, so a second frame — a host retrying — cannot re-settle it.
  function settleBootstrap(msg) {
    if (!bootstrapResolve) return
    bootstrapResolve(msg)
    bootstrapResolve = null
    bootstrapReject = null
  }

  /** @param {{ reason: string, theirs: number | null, ours: number }} verdict */
  function refuseBootstrap(verdict) {
    if (!bootstrapReject) return
    bootstrapReject(new AppError(CODES.PROTOCOL_MISMATCH, refusalMessage(verdict)))
    bootstrapResolve = null
    bootstrapReject = null
  }

  // A bootstrap with no hello in front of it is a host from before the handshake existed, which is
  // a host on a different wire: refused through the path any other version mismatch takes.
  function readBootstrap(client, msg) {
    if (!client.hello) {
      refuseBootstrap({ reason: 'no-version', theirs: null, ours: IPC_PROTOCOL_VERSION })
      return
    }
    settleBootstrap(msg)
  }

  function refuse(client, verdict) {
    client.write(JSON.stringify({
      type: FRAME.HELLO_ACK,
      ok: false,
      reason: verdict.reason,
      ours: verdict.ours,
      theirs: verdict.theirs,
    }) + '\n')
    // The primary's refusal ends the process, because there is nobody else this worker serves. Any
    // other client is simply shown the door.
    if (isPrimary(client)) refuseBootstrap(verdict)
    else clients.detach(client, 'hello refused: ' + verdict.reason)
  }

  // A client's introduction, and the only frame answered before the router is live. The protocol
  // check happens before any other field is read: a frame from a client on a different wire is
  // refused whole, rather than defaulted field by field into a degraded session. The replayed lines
  // an inline resume produces are written by events.resume() before it returns, so on the client's
  // ordered pipe they always precede the ack that describes them.
  function greetClient(client, msg) {
    if (client.hello) { log.warn('second hello from client', client.id, 'ignored'); return }
    const verdict = checkHello(msg)
    if (!verdict.ok) { refuse(client, verdict); return }
    client.hello = { kind: verdict.kind, name: verdict.name, version: verdict.version }
    log.info('hello', fields({
      client: client.id, kind: verdict.kind, name: verdict.name, version: verdict.version, trust: client.trust,
    }))
    const caught = verdict.cursor ? events.resume(client, verdict.cursor) : null
    client.write(JSON.stringify({
      type: FRAME.HELLO_ACK,
      ok: true,
      protocolVersion: IPC_PROTOCOL_VERSION,
      protocolMin: IPC_PROTOCOL_MIN_SUPPORTED,
      protocolMax: IPC_PROTOCOL_VERSION,
      trust: client.trust,
      epoch: events.epoch,
      head: events.head(),
      resume: caught ? { gap: caught.gap, replayed: caught.replayed } : null,
    }) + '\n')
  }

  return { bootstrapPromise, greetClient, readBootstrap }
}
