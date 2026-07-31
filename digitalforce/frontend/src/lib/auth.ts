/**
 * Digital Force — Auth Utilities
 * Single-user local mode: no login, no token. These are stubs kept so every
 * existing call site (api.ts, Sidebar, chat/goals pages) keeps working
 * unchanged — they just always behave as "logged in as the one local user".
 */

const DEFAULT_USER = {
  id: 'local',
  username: 'Operator',
  email: 'local@jarvis.local',
  role: 'superadmin',
}

export const getToken = (): string | null => null

export const setToken = (_token: string): void => {}

export const clearToken = (): void => {}

export const isAuthenticated = (): boolean => true

export const setUser = (_user: object): void => {}

export const getUser = (): Record<string, string> | null => DEFAULT_USER

export const authHeaders = (): Record<string, string> => ({})
