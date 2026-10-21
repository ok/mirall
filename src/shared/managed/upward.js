// The upward plane's wire format, part of the app↔Console contract and pinned by the Console's
// upward-v1.json: the instance key signs every request over its call, timestamp, nonce and the body
// bytes exactly as sent; enrollment adds the license's signature over its own message. A report is
// built from an explicit list of fields, never spread from state.
import sodium from 'sodium-native'
import b4a from 'b4a'

const LABEL = b4a.from('mirall/upward/v1')
const ENROLL_LABEL = b4a.from('mirall/upward-enroll/v1')
const ZERO = b4a.from([0])
const HOSTNAME_MAX = 64
const OS_VERSION = /^[0-9A-Za-z._+-]{1,64}$/

export const CALL = Object.freeze({ ENROLL: 'instance-enroll', REPORT: 'instance-report' })
export const NONCE_BYTES = 16

const hex = (buf) => b4a.toString(buf, 'hex')

function uint64(value) {
  const out = b4a.alloc(8)
  new DataView(out.buffer, out.byteOffset, 8).setBigUint64(0, BigInt(value))
  return out
}

function sha256(bytes) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, bytes)
  return out
}

function sign(message, secretKey) {
  const out = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(out, message, secretKey)
  return out
}

export function instanceKeyPair(seed) {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  return { publicKey, secretKey }
}

export const requestMessage = ({ call, instanceKey, timestamp, nonce, body }) =>
  b4a.concat([LABEL, ZERO, b4a.from(call), ZERO, instanceKey, uint64(timestamp), nonce, sha256(body)])

export const enrollmentMessage = ({ instanceKey, timestamp, nonce }) =>
  b4a.concat([ENROLL_LABEL, ZERO, instanceKey, uint64(timestamp), nonce])

export function signedHeaders({ call, keyPair, timestamp, nonce, body }) {
  const signature = sign(requestMessage({ call, instanceKey: keyPair.publicKey, timestamp, nonce, body }), keyPair.secretKey)
  return {
    'content-type': 'application/json',
    'x-mirall-instance-key': hex(keyPair.publicKey),
    'x-mirall-timestamp': String(timestamp),
    'x-mirall-nonce': hex(nonce),
    'x-mirall-signature': hex(signature),
  }
}

export function enrollBody({ enrollKeys, instanceKey, timestamp, nonce, report }) {
  return {
    enrollPublicKey: hex(enrollKeys.publicKey),
    enrollSignature: hex(sign(enrollmentMessage({ instanceKey, timestamp, nonce }), enrollKeys.secretKey)),
    report,
  }
}

// The short computer name a person recognizes: the network's domain suffix is not the organization's.
export function hostnameLabel(raw) {
  const short = String(raw ?? '').split('.')[0].replace(/\p{Cc}/gu, '').normalize('NFC').trim()
  const label = Array.from(short).slice(0, HOSTNAME_MAX).join('').trim()
  return label || 'unknown'
}

export function osVersionLabel(raw) {
  const value = String(raw ?? '').trim().replace(/[^0-9A-Za-z._+-]/g, '-').slice(0, 64)
  return OS_VERSION.test(value) ? value : 'unknown'
}

export function reportBody(facts) {
  const body = {
    appVersion: facts.appVersion,
    channel: facts.channel,
    platform: facts.platform,
    osVersion: osVersionLabel(facts.osVersion),
    hostnameLabel: hostnameLabel(facts.hostname),
    applied: facts.applied
      ? { profileVersionId: facts.applied.profileVersionId, issuedAt: facts.applied.issuedAt, appliedAt: facts.applied.appliedAt, via: facts.applied.via }
      : null,
    refusedKeys: [...facts.refusedKeys],
    ignoredUnlocked: [...facts.ignoredUnlocked],
    state: facts.state,
  }
  if (facts.backup) {
    const { setUp, verdict, lastSuccessAt, managedFolder } = facts.backup
    body.backup = { setUp, verdict, lastSuccessAt, managedFolder }
  }
  if (facts.reportCounter) body.reportCounter = facts.reportCounter
  return body
}
