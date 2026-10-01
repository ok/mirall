// The frame of a screen shown above the boot gate, before the shell exists: the logo-only header that
// drags the window, and a centred hero whose heading takes focus on mount so a screen reader starts
// at the title.
import { useEffect, useRef, type ReactNode } from 'react'
import type { IconName } from '../../types/ui.js'
import Logo from '../primitives/Logo.js'
import Icon from '../primitives/Icon.js'

interface PreShellHeroProps {
  icon: IconName
  title: string
  body: string
  children: ReactNode
}

export default function PreShellHero({ icon, title, body, children }: PreShellHeroProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div className="min-h-screen flex flex-col">
      <header className="fixed top-0 w-full z-50" style={{ WebkitAppRegion: 'drag' }}>
        <div className="bg-surface-container-lowest/70 backdrop-blur-xl shadow-[0_12px_40px_rgba(74,59,82,0.06)] dark:shadow-none">
          <div className="flex items-center justify-center py-4 px-8 w-full max-w-7xl mx-auto">
            <span className="flex h-8 items-center text-on-surface">
              <Logo label="Mirall" />
            </span>
          </div>
        </div>
      </header>

      <main className="flex-grow flex flex-col items-center justify-center px-8 pt-24 pb-12">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-surface-container-high flex items-center justify-center text-secondary">
              <Icon name={icon} size={32} />
            </div>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-3xl md:text-4xl font-headline font-extrabold text-accent tracking-tight focus:outline-none"
            >
              {title}
            </h1>
            <p className="text-lg text-on-surface-variant leading-relaxed">{body}</p>
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}
