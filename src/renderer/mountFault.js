// Whether a mount's durable status is a local fault, and what to name it by. The mapping lives in
// shared/contract/mount-fault.js so the two worker writers and this reader cannot drift; this file
// stays as the renderer's import path.
export { isMountFault, mountFault } from '../shared/contract/mount-fault.js'
