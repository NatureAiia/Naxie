// A small, optional response-envelope convention for Express routes — ported
// from the "steal from Sebastian" review (KimmyDeku/sebastian's ApiResult<T>
// + its ai.ts errorResponse helper). Naxie's routes today are all ad hoc:
// some return { ok, ... }, some a bare route-specific key, error shapes vary
// route to route (confirmed across routes/tasks.ts, personas.ts, feedback.ts).
//
// These are thin wrappers, not a new abstraction layer — nothing existing is
// forced to adopt them. New or touched routes should prefer them so the
// shape converges over time instead of drifting further apart.

import type { Response } from "express";

export type ApiOk<T extends object = object> = { ok: true } & T;
export type ApiError = { ok: false; code: string; error: string };

export const respond = {
  ok<T extends object>(res: Response, data: T, status = 200): void {
    res.status(status).json({ ok: true, ...data } as ApiOk<T>);
  },

  // code is a short machine-readable tag (e.g. "not_found", "ai_unavailable",
  // "invalid_input") — status carries the HTTP semantics, code carries the
  // reason a client-side switch can branch on without parsing prose.
  error(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({ ok: false, code, error: message } satisfies ApiError);
  },

  // "Ran fine, but there's nothing to show" — distinct from error() so a
  // client can render an EmptyState instead of an ErrorState (mirrors
  // Sebastian's api/news and api/recipes routes' empty-vs-error distinction).
  empty(res: Response, message: string, status = 404): void {
    res.status(status).json({ ok: false, code: "empty", error: message } satisfies ApiError);
  },
};
