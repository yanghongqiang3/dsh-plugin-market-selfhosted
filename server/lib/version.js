/**
 * Semantic version parsing and comparison.
 *
 * Shared by the SERVICE (choosing which artifact version is "latest") and the CLIENT
 * plugin (deciding whether the service carries a newer copy of itself). One
 * implementation, because two would drift — and a client and server that disagree about
 * which of two versions is higher is worse than either being wrong alone.
 *
 * WHY THIS EXISTS AT ALL, and it is a bug fix rather than a nicety:
 *
 * "Latest" used to mean `ORDER BY published_at DESC` — MOST RECENTLY PUBLISHED. That is
 * not the same as the highest version, and the difference is a downgrade dressed as an
 * upgrade. Measured (`tools/probe-version-order.mjs`) by publishing 2.0.0, then 1.5.0,
 * then 1.0.0 — which is what happens when a hotfix is published from an older branch:
 *
 *     the catalog reported 1.0.0
 *     a client running 2.0.0 was offered 「更新到 1.0.0」
 *     an unpinned download served 1.0.0
 *
 * SQLite cannot order semantic versions either (`ORDER BY version DESC` puts 1.9.0 above
 * 1.10.0), so comparison happens here, in JS.
 *
 * Semver precedence, per the spec's rules: numeric identifiers compare numerically,
 * alphanumerics lexically, a release outranks any of its prereleases (1.0.0 > 1.0.0-rc.1),
 * and a longer prerelease list outranks a shorter equal prefix (1.0.0-alpha.1 >
 * 1.0.0-alpha). Build metadata carries no precedence and is ignored.
 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse into comparable parts, or `null` when the string is not a semantic version. */
export function parseVersion(version) {
  const match = VERSION_RE.exec(String(version ?? ''))
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Compare two prerelease identifier lists; `[]` (a release) outranks any of them. */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
      continue
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** `-1` / `0` / `1` for highest-first sorting. Unparseable versions sort lowest. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) {
    if (left === null && right === null) return String(a).localeCompare(String(b))
    return left === null ? -1 : 1
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}
