// Plain CSS-string department accent color — shared by the Office dashboard
// (DepartmentCard, TaskStatusPanel) and Calendar's day chips so both read the
// same tokens the same way instead of three copies of this mapping. Ported
// from the deleted OfficeScene.tsx's Three.js-flavored departmentColor() —
// same token → color mapping, returning a CSS string instead of a THREE.Color.
//
// violet/coral/leaf are this app's own theme-aware CSS vars (tailwind.config.js
// / index.css), read live so department tints track the app's actual palette.
// Other department-templates.ts color words (blue/amber/purple/teal/slate)
// have no custom token — those fall back to a static Tailwind hex. Anything
// unrecognized (a custom department's arbitrary color string) gets neutral gray.
const STATIC_FALLBACK: Record<string, string> = {
  blue: "#3b82f6", amber: "#f59e0b", purple: "#a855f7", teal: "#14b8a6", slate: "#64748b",
  red: "#ef4444", navy: "#1e3a8a",
};

function getCssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

export function departmentColor(token: string): string {
  const t = (token || "").toLowerCase().trim();
  if (t === "violet") return getCssVar("--c-violet-500", "#7d57f6");
  if (t === "coral") return getCssVar("--c-coral-500", "#f26b5e");
  if (t === "green" || t === "leaf") return getCssVar("--c-leaf-500", "#4caf6d");
  if (STATIC_FALLBACK[t]) return STATIC_FALLBACK[t];
  return "#6b7280";
}
