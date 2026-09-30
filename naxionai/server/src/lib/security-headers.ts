// Baseline security headers beyond the CORS / X-Frame-Options / etc. block
// already set inline in index.ts. Content-Security-Policy and
// Permissions-Policy specifically were entirely absent (no helmet dependency
// either) — this fills that gap without touching the existing per-request
// header block. The three headers below overlap with it; re-setting them to
// the same value is harmless (res.setHeader replaces, it doesn't append) and
// keeps this module usable on its own.
//
// The allow-list is scoped to what this app actually serves, confirmed
// against web/index.html, vite.config.ts, and web/src:
//   - Google Fonts stylesheet + font files (index.html <link>s)
//   - Monaco's DEFAULT loader — @monaco-editor/react has no loader.config
//     override, so the IDE/DocEditor pages pull the editor + its workers
//     (and inject <style> blocks) straight from the jsdelivr CDN
//   - the realtime voice call's browser->OpenAI WebRTC handshake
//     (useRealtimeCall.ts posts straight to api.openai.com — that's a
//     first-party feature of this app, not third-party injection, so it's
//     named explicitly rather than left to a same-origin default)
// A tighter policy would break those features rather than make anything
// more secure, since none of them are the injection vectors CSP exists to
// stop.

import type { Request, Response, NextFunction } from "express";

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://api.openai.com https://cdn.jsdelivr.net",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// microphone=(self) is load-bearing: the realtime voice call and the
// mic-level meter both call getUserMedia({audio:true}) from the app's own
// origin. Everything else here is unused by the app today, so denied.
const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=(self)",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "midi=()",
  "fullscreen=(self)",
  "display-capture=()",
].join(", ");

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}
