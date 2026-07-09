import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../components/primitives/Modal.js'
import { useKeyboard } from './KeyboardProvider.js'
import AcceleratorLabel from './AcceleratorLabel.js'
import type { Command } from './registry.js'

function rank(label: string, q: string): number {
  if (!q) return 1
  if (label === q) return 200
  if (label.startsWith(q)) return 100
  if (label.includes(' ' + q)) return 50
  if (label.includes(q)) return 25
  return 0
}

export default function CommandPalette() {
  const { t } = useTranslation()
  const { paletteOpen, closePalette, runCommand, commands } = useKeyboard()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (paletteOpen) {
      setQuery('')
      setActive(0)
      const id = window.setTimeout(() => inputRef.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    return
  }, [paletteOpen])

  const ranked = useMemo<Command[]>(() => {
    const q = query.trim().toLowerCase()
    return commands
      .filter((c) => c.group !== 'system')
      .map((c) => ({ c, score: rank(t(c.labelKey, c.labelParams).toLowerCase(), q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c)
  }, [commands, query, t])

  useEffect(() => {
    if (active >= ranked.length) setActive(Math.max(0, ranked.length - 1))
  }, [ranked.length, active])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[active]
    if (item instanceof HTMLElement) item.scrollIntoView({ block: 'nearest' })
  }, [active])

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      setActive((i) => Math.min(i + 1, ranked.length - 1))
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      setActive((i) => Math.max(i - 1, 0))
      e.preventDefault()
    } else if (e.key === 'Enter') {
      const cmd = ranked[active]
      if (cmd) {
        e.preventDefault()
        e.stopPropagation()
        closePalette()
        runCommand(cmd.id)
      }
    }
  }

  return (
    <Modal isOpen={paletteOpen} onClose={closePalette} ariaLabel={t('palette.title')} panelClassName="glass-modal w-full max-w-xl rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative">
      <div className="p-6">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={handleKeyDown}
          placeholder={t('palette.placeholder')}
          inputMode="search"
          role="combobox"
          aria-label={t('palette.placeholder')}
          aria-expanded={ranked.length > 0}
          aria-controls="command-palette-listbox"
          aria-activedescendant={ranked[active]?.id}
          aria-autocomplete="list"
          className="w-full bg-surface-container-low border-none rounded-xl px-5 py-4 text-accent font-medium placeholder:text-outline/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 transition-all"
        />
        <ul ref={listRef} id="command-palette-listbox" role="listbox" className="mt-4 max-h-80 overflow-y-auto scrollbar-thin">
          {ranked.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-on-surface-variant">
              {t('palette.noResults')}
            </li>
          )}
          {ranked.map((c, i) => (
            <li
              key={c.id}
              id={c.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                closePalette()
                runCommand(c.id)
              }}
              className={`flex items-center justify-between px-4 py-2.5 rounded-xl cursor-pointer text-sm font-medium ${i === active ? 'bg-surface-container-high/60 text-accent' : 'text-on-surface'}`}
            >
              <span className="truncate">{t(c.labelKey, c.labelParams)}</span>
              {c.accelerator && (
                <span className="ml-4 shrink-0 font-mono text-xs text-on-surface-variant">
                  <AcceleratorLabel spec={c.accelerator} />
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
