'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, type ComponentType } from 'react'
import {
  LayoutDashboard, Target, BarChart2, Cpu, Settings, MessageSquare,
  LogOut, Sparkles, Volume2, Network, ChevronRight, Search as SearchIcon,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'
import { clearToken, getUser } from '@/lib/auth'
import api from '@/lib/api'
import { BrandMark } from './BrandMark'
import { PixelDriftText } from './PixelDriftText'
import { Kbd, MetaKey } from './Kbd'

type NavItem = {
  href: string
  label: string
  icon: ComponentType<{ size?: number; className?: string }>
  badge?: number
}

// Primary: the everyday surfaces, always visible. Everything else folds into
// a collapsible group so the rail stays short as more pages land in later
// migration phases (see naxionai/frontend Phase 0 plan) — new pages join an
// existing group instead of the rail growing flat and long.
const primaryNav: NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/naxie', label: 'Naxie', icon: Sparkles },
]

function makeWorkspaceNav(awaitingCount: number): NavItem[] {
  return [
    { href: '/goals', label: 'Tasks', icon: Target, badge: awaitingCount || undefined },
  ]
}

const libraryNav: NavItem[] = [
  { href: '/knowledge', label: 'Knowledge Core', icon: Network },
  { href: '/skills', label: 'SkillForge', icon: Cpu },
  { href: '/tts', label: 'TTS Studio', icon: Volume2 },
]

const systemNav: NavItem[] = [
  { href: '/analytics', label: 'Analytics', icon: BarChart2 },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [mounted, setMounted] = useState(false)
  const [awaitingCount, setAwaitingCount] = useState(0)
  const [agentStatus, setAgentStatus] = useState<'idle' | 'planning' | 'executing' | 'awaiting'>('idle')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('naxionai.sidebarCollapsed') === '1'
  })

  useEffect(() => {
    setMounted(true)
    setUser(getUser())

    const check = async () => {
      try {
        const goals = await api.goals.list()
        const awaiting = goals.filter(g => g.status === 'awaiting_approval').length
        const executing = goals.filter(g => g.status === 'executing').length
        const planning = goals.filter(g => g.status === 'planning').length

        setAwaitingCount(awaiting)
        if (executing > 0) setAgentStatus('executing')
        else if (planning > 0) setAgentStatus('planning')
        else if (awaiting > 0) setAgentStatus('awaiting')
        else setAgentStatus('idle')
      } catch { /* no-op */ }
    }
    check()
    const interval = setInterval(check, 15000)
    return () => clearInterval(interval)
  }, [])

  // Responsive: force-collapse under the tablet breakpoint, restore the
  // saved preference above it — same pattern as neuroworks' Layout.tsx.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia('(max-width: 819px)')
    const apply = () => {
      if (mql.matches) setCollapsed(true)
      else setCollapsed(localStorage.getItem('naxionai.sidebarCollapsed') === '1')
    }
    apply()
    mql.addEventListener?.('change', apply)
    window.addEventListener('resize', apply)
    return () => {
      mql.removeEventListener?.('change', apply)
      window.removeEventListener('resize', apply)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('naxionai.sidebarCollapsed', collapsed ? '1' : '0')
  }, [collapsed])

  const STATUS_CONFIG = {
    idle: { label: 'System idle', dot: '#94A3B8' },
    planning: { label: 'Synthesizing…', dot: '#67E8F9' },
    executing: { label: 'Executing', dot: '#33BAFF' },
    awaiting: { label: 'Approval required', dot: '#FCD34D' },
  }
  const st = STATUS_CONFIG[agentStatus]

  const handleLogout = () => {
    clearToken()
    router.push('/login')
  }

  const openCommandPalette = () => {
    const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true })
    document.dispatchEvent(ev)
  }

  const isActive = (href: string) => pathname === href || (href !== '/' && pathname.startsWith(href))

  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon
    const active = isActive(item.href)
    return (
      <Link
        key={item.href}
        href={item.href}
        title={collapsed ? item.label : undefined}
        className={`flex items-center gap-3 py-2 rounded-md text-sm transition-colors ${collapsed ? 'justify-center px-2' : 'px-3'} ${
          active ? 'bg-ink-800 text-cream-50' : 'text-cream-300 hover:text-cream-50 hover:bg-ink-800/60'
        }`}
      >
        <Icon size={16} className="shrink-0" />
        {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
        {!collapsed && item.badge ? (
          <span className="bg-amber-500/20 text-amber-400 text-[10px] px-1.5 py-0.5 rounded-full font-mono">{item.badge}</span>
        ) : null}
      </Link>
    )
  }

  const renderGroup = (key: string, label: string, items: NavItem[]) => {
    const hasActive = items.some(n => isActive(n.href))
    const open = openGroups[key] ?? hasActive
    if (collapsed) return items.map(renderNavItem)
    return (
      <div key={key}>
        <button
          type="button"
          onClick={() => setOpenGroups(g => ({ ...g, [key]: !(g[key] ?? hasActive) }))}
          className="w-full flex items-center gap-3 px-3 py-2 mt-3 rounded-md text-sm text-cream-300 hover:text-cream-50 hover:bg-ink-800/60 transition-colors"
        >
          <span className="flex-1 text-left">{label}</span>
          <ChevronRight size={14} className={`text-cream-300/50 transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        {open && (
          <div className="ml-3 pl-3 border-l border-ink-800 space-y-0.5">
            {items.map(renderNavItem)}
          </div>
        )}
      </div>
    )
  }

  return (
    <aside
      className={`shrink-0 bg-ink-900 border-r border-ink-800 flex flex-col transition-[width] duration-200 overflow-hidden ${collapsed ? 'w-16' : 'w-60'}`}
      style={{ minHeight: '100vh', position: 'sticky', top: 0, height: '100vh', zIndex: 50 }}
    >
      <div className={`flex items-center ${collapsed ? 'flex-col gap-2 px-2 py-4' : 'justify-between px-4 py-4 tablet:px-5'}`}>
        <Link href="/" className={`flex items-center gap-2.5 min-w-0 ${collapsed ? 'justify-center' : ''}`}>
          <BrandMark size={26} />
          {!collapsed && (
            <div className="w-[140px] h-8">
              <PixelDriftText text="NaxionAI" />
            </div>
          )}
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label="Toggle sidebar"
          className="grid place-items-center w-7 h-7 border border-ink-700 hover:border-violet-500/40 rounded-md text-cream-300 hover:text-cream-100 transition-colors shrink-0"
        >
          {collapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
        </button>
      </div>

      {/* Status pill */}
      <div className={collapsed ? 'px-2 pb-3' : 'px-3 pb-3'}>
        <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border border-ink-700 bg-ink-850 ${collapsed ? 'justify-center px-2' : ''}`}>
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.dot, boxShadow: agentStatus !== 'idle' ? `0 0 8px ${st.dot}` : 'none' }} />
          {!collapsed && <span className="text-cream-300 truncate">{st.label}</span>}
        </div>
      </div>

      {!collapsed && (
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={openCommandPalette}
            className="flex items-center gap-2 text-xs px-3 py-1.5 border border-ink-700 hover:border-violet-500/40 rounded-md text-cream-300 hover:text-cream-100 transition-colors w-full"
            title="Open command palette"
          >
            <SearchIcon size={12} />
            <span className="flex-1 text-left">Search</span>
            <span className="flex items-center gap-0.5"><MetaKey /><Kbd>K</Kbd></span>
          </button>
        </div>
      )}

      <nav className={`flex-1 space-y-0.5 overflow-y-auto scrollbar-thin ${collapsed ? 'px-2' : 'px-3'}`}>
        {primaryNav.map(renderNavItem)}
        {renderGroup('workspace', 'Workspace', makeWorkspaceNav(awaitingCount))}
        {renderGroup('library', 'Library', libraryNav)}
        {renderGroup('system', 'System', systemNav)}
      </nav>

      <div className={collapsed ? 'px-2 py-3 border-t border-ink-800' : 'px-3 py-3 border-t border-ink-800'}>
        {mounted && user && !collapsed && (
          <div className="px-3 py-2 mb-2 rounded-md bg-ink-850">
            <div className="text-sm text-cream-50 font-medium truncate">
              {user.full_name || user.email?.split('@')[0] || 'Operator'}
            </div>
            <div className="text-[10px] text-cream-300/60 uppercase tracking-wide mt-0.5">
              {user.role || 'local'}
            </div>
          </div>
        )}
        <button
          onClick={handleLogout}
          title={collapsed ? 'Log out' : undefined}
          className={`w-full flex items-center gap-2.5 py-2 rounded-md text-sm text-cream-300/70 hover:text-flame-400 transition-colors ${collapsed ? 'justify-center px-2' : 'px-3'}`}
        >
          <LogOut size={16} />
          {!collapsed && 'Log out'}
        </button>
      </div>
    </aside>
  )
}
