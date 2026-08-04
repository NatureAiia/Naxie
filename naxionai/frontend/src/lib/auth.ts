/**
 * NAXIONAI — Auth Utilities
 *
 * Default (NEXT_PUBLIC_REAL_AUTH unset/"0"): single-user local mode — no
 * login, no token. Every existing call site (api.ts, Sidebar, voice.ts,
 * chat/goals pages) keeps working unchanged, always "logged in" as the one
 * local user. This matches the backend's current behavior (auth.py bypasses
 * per-request tokens until the Phase 1 migration work lands).
 *
 * With NEXT_PUBLIC_REAL_AUTH="1": real localStorage-backed token/session,
 * ready for the backend's /api/auth/* endpoints once they exist. Flip this
 * on only after the backend actually enforces tokens — turning it on first
 * locks every page out against a backend still running in local-user mode.
 */

const REAL_AUTH = process.env.NEXT_PUBLIC_REAL_AUTH === '1'

const TOKEN_KEY = 'naxionai.token'
const USER_KEY = 'naxionai.user'

const DEFAULT_USER = {
  id: 'local',
  username: 'Operator',
  email: 'local@naxie.local',
  role: 'superadmin',
  layer: 'superadmin',
}

function readLocalStorage(key: string): string | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage.getItem(key) } catch { return null }
}

export const getToken = (): string | null => {
  if (!REAL_AUTH) return null
  return readLocalStorage(TOKEN_KEY)
}

export const setToken = (token: string): void => {
  if (!REAL_AUTH || typeof window === 'undefined') return
  try { window.localStorage.setItem(TOKEN_KEY, token) } catch { /* ignore */ }
}

export const clearToken = (): void => {
  if (!REAL_AUTH || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(TOKEN_KEY)
    window.localStorage.removeItem(USER_KEY)
  } catch { /* ignore */ }
}

export const isAuthenticated = (): boolean => {
  if (!REAL_AUTH) return true
  return !!getToken()
}

export const setUser = (user: object): void => {
  if (!REAL_AUTH || typeof window === 'undefined') return
  try { window.localStorage.setItem(USER_KEY, JSON.stringify(user)) } catch { /* ignore */ }
}

export const getUser = (): Record<string, string> | null => {
  if (!REAL_AUTH) return DEFAULT_USER
  const raw = readLocalStorage(USER_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export const authHeaders = (): Record<string, string> => {
  if (!REAL_AUTH) return {}
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
