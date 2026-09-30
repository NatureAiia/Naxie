// Pure versioning rules for marketplace skill exports. Extracted from the
// /export/:id route so it can be unit-tested (repo convention: test pure
// decision logic, not route I/O).
//
// Rules:
// - No existing content → 1.0.0, unless an explicit valid semver is requested.
// - Existing content carries `version: X.Y.Z` frontmatter → bump patch.
// - Existing content without version frontmatter → assume 1.0.0, so 1.0.1.
// - Requested versions are honored only when the skill is new (first export).

const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function isValidSemver(v: string): boolean {
  return SEMVER_RE.test(v);
}

export function bumpPatch(v: string): string {
  const parts = v.split(".").map(Number);
  parts[2] = (parts[2] ?? 0) + 1;
  return parts.join(".");
}

export function nextSkillVersion(existingContent: string | null, requested?: string): string {
  if (!existingContent) {
    if (requested && isValidSemver(requested.trim())) return requested.trim();
    return "1.0.0";
  }
  const m = existingContent.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m);
  if (m) return bumpPatch(m[1]);
  return "1.0.1";
}
