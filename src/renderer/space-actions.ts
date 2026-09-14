// An action aimed at SpaceView from somewhere else — a command fired on the folder screen, a
// "mirror this folder" from the folder screen's own menu. SpaceView owns the dialogs behind them,
// so the action has to outlive the navigation that gets there.
//
// It is held as navigation state rather than dispatched as a window event: the screen is not
// mounted at the moment the action is raised, and firing on the next macrotask in the hope that it
// is by then is a race nothing retries — a mount that slips past that tick drops the action with no
// trace. As state it simply waits, and the screen clears it once it has acted.
export type SpaceAction = 'add-files' | 'add-folder' | 'invite' | 'leave' | 'edit'

export type PendingSpaceAction =
  | { kind: 'action'; action: SpaceAction }
  // Carries the share's id, not the share: by the time SpaceView reads it the listing is the
  // authority on what that folder is.
  | { kind: 'mirror'; shareId: string }
