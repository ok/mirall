// SpaceView owns the modals behind these actions, so a command that fires from the folder
// view has to get back to SpaceView before the action can land. app.tsx navigates first and
// then dispatches; SpaceView listens while it is mounted.
export type SpaceAction = 'add-files' | 'add-folder' | 'invite' | 'leave' | 'edit'

export const SPACE_ACTION_EVENT = 'mirall:space-action'

export function dispatchSpaceAction(action: SpaceAction): void {
  window.dispatchEvent(new CustomEvent<SpaceAction>(SPACE_ACTION_EVENT, { detail: action }))
}
