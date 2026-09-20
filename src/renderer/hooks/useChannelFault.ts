import { useSyncExternalStore } from 'react'
import { getChannelFault, subscribeChannelFault, type ChannelFault } from '../ipc/ipc.js'

// The worker channel's terminal state, read by the shell before any other gate. useSyncExternalStore
// rather than an effect + state: the fault can be raised before the first render (a worker that
// refuses its bootstrap exits in milliseconds), and a mirror in component state would miss it.
export function useChannelFault(): ChannelFault | null {
  return useSyncExternalStore(subscribeChannelFault, getChannelFault, getChannelFault)
}
