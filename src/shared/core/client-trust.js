// Stopping or restarting the worker ends every client's session, so it is the host's call and not a
// thing any connected peer may ask for. Every client is the host until the worker listens on a
// socket, so this refuses nobody today — the rule is in place before the first client it would.
import { AppError } from './errors.js'
import { CODES } from '../contract/errors.js'

export function requireHost(client) {
  if (client?.trust === 'host') return
  throw new AppError(CODES.NOT_AUTHORIZED, 'only the host may stop the worker')
}
