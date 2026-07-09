// Mint an invite from INSIDE a space. The modal now configures the link first (auto-approve off by
// default, default expiry) and reveals it only after "Create invite link"; we then copy the
// `mirall://join/<code>` app link and strip the prefix to the bare code. Caller must already be in
// the space view.
export async function copyInvite(A) {
  await A.openInviteModal()
  await A.click({ role: 'button', name: 'Create invite link' })
  await A.waitText('Invite link ready', 8000)
  const raw = await A.copyFrom({ role: 'button', name: 'Copy' })
  await A.click({ role: 'button', name: 'Done' })
  return raw.replace(/^mirall:\/\/join\//, '')
}

// Create a space on A and return a bare invite code minted from the in-space Invite modal.
export async function createSpaceWithInvite(A, { name = 'Aurora' } = {}) {
  await A.click({ role: 'button', name: 'Create Space' })
  await A.waitText('Create a New Space')
  await A.type({ role: 'textfield' }, name)
  await A.click({ role: 'button', name: 'Initialize Space' })
  await A.waitText('Space Created')
  await A.click({ role: 'button', name: 'Done' })
  await A.waitText(name)
  return copyInvite(A)
}

// Join a space by code and stop at the pending "Waiting to be let in" state (membership approval is
// on, so a plain join leaves the joiner pending until a member approves).
export async function joinPending(B, code) {
  await B.click({ role: 'button', name: 'Join Space' })
  await B.waitText('Join a Space')
  await B.type({ role: 'textfield', name: 'Invite Code' }, code)
  await B.click({ role: 'button', name: 'Join Space', last: true })
  await B.waitText('Waiting to be let in', 30000)
}

// Create a space on A, join it on B, and admit B so it is a full member (membership approval is on,
// so a plain join leaves B pending — the owner approves it here). Returns the invite code; leaves
// both instances inside the space-view of the new space. (The approval-flow scenarios s54–s59
// deliberately drive the pending path themselves.)
export async function connectInSpace(A, B, { name = 'Aurora' } = {}) {
  const code = await createSpaceWithInvite(A, { name })
  await joinPending(B, code)

  // Approve B so it becomes a full member (B.name is its display name).
  await A.focus()
  await A.waitText('wants to join', 30000)
  await A.click({ role: 'button', name: `Approve ${B.name}` })
  await B.waitText('Drop to Share', 30000)
  return code
}
