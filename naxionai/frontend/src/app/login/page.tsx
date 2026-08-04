'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, Loader2 } from 'lucide-react'
import api from '@/lib/api'
import { setToken, setUser } from '@/lib/auth'

// Real login/signup UI (Phase 1). Only reachable/meaningful once the backend
// enforces auth (NEXT_PUBLIC_REAL_AUTH + settings.require_auth both on) —
// harmless to visit before that, it just won't be linked to from anywhere.
export default function LoginPage() {
  const router = useRouter()
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null)
  const [mode, setMode] = useState<'signin' | 'join'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [fullName, setFullName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)

  useEffect(() => {
    api.auth.state()
      .then(s => setNeedsBootstrap(s.needs_bootstrap))
      .catch(() => setNeedsBootstrap(false))
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setPendingMessage(null)
    setBusy(true)
    try {
      if (needsBootstrap || mode === 'join') {
        const res = await api.auth.signup({ email, password, username, full_name: fullName || undefined })
        if ('access_token' in res) {
          setToken(res.access_token)
          setUser(res.user)
          router.push('/')
        } else {
          setPendingMessage(res.message)
        }
      } else {
        const res = await api.auth.login({ email, password })
        setToken(res.access_token)
        setUser(res.user)
        router.push('/')
      }
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const bootstrapping = needsBootstrap === true
  const heading = bootstrapping ? 'Create the owner account' : mode === 'join' ? 'Request access' : 'Sign in'

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm bg-ink-900 border border-ink-800 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-6">
          <Sparkles size={20} className="text-violet-400" />
          <div className="text-lg font-semibold text-cream-50">NaxionAI</div>
        </div>

        <h1 className="text-sm font-semibold text-cream-100 mb-1">{heading}</h1>
        <p className="text-xs text-cream-300/60 mb-5">
          {bootstrapping
            ? 'First account on this instance becomes the owner.'
            : mode === 'join'
            ? 'An admin will need to approve your account before you can sign in.'
            : 'Welcome back.'}
        </p>

        {pendingMessage ? (
          <div className="text-sm text-cream-100 bg-ink-850 border border-ink-700 rounded-lg p-4">
            {pendingMessage}
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {(bootstrapping || mode === 'join') && (
              <input
                className="df-input"
                placeholder="Username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            )}
            {(bootstrapping || mode === 'join') && (
              <input
                className="df-input"
                placeholder="Full name (optional)"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
              />
            )}
            <input
              className="df-input"
              type="email"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
            <input
              className="df-input"
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={8}
            />

            {error && <div className="text-xs text-flame-400">{error}</div>}

            <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {bootstrapping ? 'Create account' : mode === 'join' ? 'Request access' : 'Sign in'}
            </button>
          </form>
        )}

        {!bootstrapping && !pendingMessage && (
          <button
            type="button"
            onClick={() => setMode(m => (m === 'signin' ? 'join' : 'signin'))}
            className="mt-4 text-xs text-cream-300/60 hover:text-cream-100 transition-colors"
          >
            {mode === 'signin' ? "Don't have an account? Request access" : 'Already have an account? Sign in'}
          </button>
        )}
      </div>
    </div>
  )
}
