'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'

type Layer = 'staff' | 'admin' | 'superadmin'

// Client-side route guard, ported from neuroworks' AdminOnly (App.tsx).
// Defense-in-depth only — the backend's require_role() already gates the
// underlying API calls; this just stops a staff user from landing on a page
// that would only 403 on action. No session (single-user local mode, or
// NEXT_PUBLIC_REAL_AUTH off) = full access, matching getUser()'s stub.
export function RequireRole({ allow, redirectTo = '/', children }: { allow: Layer[]; redirectTo?: string; children: ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    const user = getUser()
    const layer = (user?.layer as Layer | undefined) ?? 'superadmin'
    if (allow.includes(layer)) {
      setAllowed(true)
    } else {
      router.replace(redirectTo)
    }
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!ready || !allowed) return null
  return <>{children}</>
}
