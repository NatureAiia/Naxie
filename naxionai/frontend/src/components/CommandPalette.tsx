'use client'

import { Command } from 'cmdk'
import { useEffect, useState, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import {
  LayoutDashboard, MessageSquare, Sparkles, Target, Network, Cpu,
  Volume2, BarChart2, Settings, Search as SearchIcon,
} from 'lucide-react'
import { Kbd, MetaKey } from './Kbd'

// Ported from neuroworks' CommandPalette.tsx (useNavigate -> useRouter).
// Item list intentionally covers only routes that exist today — extend this
// as each migration phase lands its pages, rather than advertising dead
// links ahead of the backend/frontend work that would back them.
type Item = {
  id: string
  label: string
  icon: ComponentType<{ size?: number | string; className?: string }>
  onSelect: () => void
  keywords?: string
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
      if (e.key === 'Escape' && open) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  function go(to: string) {
    return () => { router.push(to); setOpen(false) }
  }

  const items: Item[] = [
    { id: 'n-overview', label: 'Overview', icon: LayoutDashboard, onSelect: go('/'), keywords: 'home dashboard' },
    { id: 'n-chat', label: 'Chat', icon: MessageSquare, onSelect: go('/chat'), keywords: 'talk message' },
    { id: 'n-naxie', label: 'Naxie', icon: Sparkles, onSelect: go('/naxie'), keywords: 'voice assistant mic talk speak naxie jarvis' },
    { id: 'n-tasks', label: 'Tasks', icon: Target, onSelect: go('/goals'), keywords: 'goals jobs queue' },
    { id: 'n-knowledge', label: 'Knowledge Core', icon: Network, onSelect: go('/knowledge'), keywords: 'vault notes rag search' },
    { id: 'n-skills', label: 'SkillForge', icon: Cpu, onSelect: go('/skills'), keywords: 'skill code capability' },
    { id: 'n-tts', label: 'TTS Studio', icon: Volume2, onSelect: go('/tts'), keywords: 'voice speech text to speech' },
    { id: 'n-analytics', label: 'Analytics', icon: BarChart2, onSelect: go('/analytics'), keywords: 'metrics stats' },
    { id: 'n-settings', label: 'Settings', icon: Settings, onSelect: go('/settings'), keywords: 'config preferences' },
  ]

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" />
      <Command
        label="Command palette"
        className="relative w-full max-w-xl bg-ink-900 border border-ink-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 border-b border-ink-800">
          <SearchIcon size={16} className="text-cream-300/60" />
          <Command.Input
            autoFocus
            placeholder="Search pages…"
            className="flex-1 bg-transparent py-3 text-sm text-cream-50 placeholder:text-cream-300/40 focus:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <Command.List className="max-h-[60vh] overflow-y-auto scrollbar-thin p-2">
          <Command.Empty className="text-sm text-cream-300/60 text-center py-8">
            No results.
          </Command.Empty>
          <Command.Group
            heading="Navigate"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-cream-300/50"
          >
            {items.map(i => {
              const Icon = i.icon
              return (
                <Command.Item
                  key={i.id}
                  value={`${i.label} ${i.keywords ?? ''}`}
                  onSelect={i.onSelect}
                  className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-cream-200 cursor-pointer aria-selected:bg-ink-800 aria-selected:text-cream-50"
                >
                  <Icon size={16} className="text-cream-300/70" />
                  <span className="flex-1">{i.label}</span>
                </Command.Item>
              )
            })}
          </Command.Group>
        </Command.List>
        <div className="border-t border-ink-800 px-4 py-2 flex items-center gap-3 text-[10px] text-cream-300/50">
          <span className="flex items-center gap-1"><Kbd>↑↓</Kbd> navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> select</span>
          <span className="ml-auto flex items-center gap-1"><MetaKey /><Kbd>K</Kbd> toggle</span>
        </div>
      </Command>
    </div>
  )
}
