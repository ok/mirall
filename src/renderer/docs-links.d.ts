type TutorialAnchor = 'send-your-first-files'

type GuideAnchor =
  | 'create-a-space'
  | 'join-a-space'
  | 'fix-a-stuck-join'
  | 'share-files'
  | 'share-a-folder'

type ExplanationAnchor =
  | 'membership-approval'
  | 'spaces-members-availability'

export type DocsTarget =
  | { page: 'hub' }
  | { page: 'tutorials'; anchor: TutorialAnchor }
  | { page: 'guides'; anchor: GuideAnchor }
  | { page: 'explanation'; anchor: ExplanationAnchor }

export function docsUrl(target: DocsTarget): string
