/**
 * Market server — artifact storage.
 *
 * One artifact is a gzipped tar of the plugin package directory, stored under
 * `<storageDir>/<name>/<version>/<channel>.tgz`. The sha256 recorded here is the
 * installer's integrity check on the way back out, so the server cannot silently
 * serve different bytes than it advertised — and `readVerified` re-hashes before
 * every download rather than trusting the file on disk.
 *
 * Two ways in:
 *   - publishFromDirectory: the bytes are on this machine (server-side CLI)
 *   - publishArchive:       an already-packed archive arrives over HTTP (upload/CI)
 *
 * Publishing metadata comes from `market.json` beside `package.json`:
 *
 *   { "summary": "...", "owner": "billing", "channel": "stable",
 *     "dsh": ">=0.2.0-rc.2 <0.3", "permissions": ["tools"], "state": "published" }
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { rowToArtifact } from './db.js'
import { ArchiveError, collectFiles, inspectArchive, packTarGz, sha256 } from './pack.js'

const NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/
export const ARTIFACT_STATES = ['draft', 'review', 'published', 'revoked']

/**
 * Version ordering — `semver`, restricted to what this market needs.
 *
 * WHY THIS EXISTS AT ALL, and it is a bug fix rather than a nicety:
 *
 * "Latest" used to mean `ORDER BY published_at DESC` — MOST RECENTLY PUBLISHED. That is
 * not the same as the highest version, and the difference is a downgrade dressed as an
 * upgrade. Measured (`tools/probe-version-order.mjs`) by publishing 2.0.0, then 1.5.0,
 * then 1.0.0 — which is what happens when a hotfix is published from an older branch:
 *
 *     catalog reported 1.0.0
 *     an install at 2.0.0 was offered 「更新到 1.0.0」
 *     the unpinned download served 1.0.0
 *
 * The install page decides whether to show that button by comparing the catalog's
 * version with the installed one, so this ordering IS the update mechanism.
 *
 * A second defect lived in the same expression: the ordering took no notice of `state`,
 * so a REVOKED newest version was still reported as latest. `policy` refuses it
 * (`E_REVOKED`) — but by then the user has already been shown a button that cannot work.
 * Both are fixed by selecting over publishable versions only.
 *
 * Semver precedence, implemented per the spec's rules:
 *   numeric identifiers compare numerically, alphanumerics lexically, a release outranks
 *   any of its prereleases (1.0.0 > 1.0.0-rc.1), and a longer prerelease list outranks a
 *   shorter equal prefix (1.0.0-alpha.1 > 1.0.0-alpha). Build metadata carries no
 *   precedence and is ignored.
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

/** Only an artifact in this state may be installed (mirrors `policy.js`). */
const PUBLISHABLE = 'published'


export class Artifacts {
  constructor(db, storageDir) {
    this.db = db
    this.storageDir = resolve(storageDir)
    mkdirSync(this.storageDir, { recursive: true })
  }

  /** Resolve a storage path and refuse anything escaping the storage root. */
  contain(...parts) {
    const target = resolve(this.storageDir, ...parts)
    if (target !== this.storageDir && !target.startsWith(this.storageDir + sep)) {
      throw new Error(`path escapes artifact storage: ${target}`)
    }
    return target
  }

  // ------------------------------------------------------------------ publish

  /** Pack a package directory that lives on this machine, then record it. */
  publishFromDirectory(packageDir, { publishedBy = 'system', state = null, channel = null } = {}) {
    const dir = resolve(packageDir)
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) throw new Error(`no package.json in ${dir}`)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const marketPath = join(dir, 'market.json')
    const meta = existsSync(marketPath) ? JSON.parse(readFileSync(marketPath, 'utf8')) : {}

    const files = collectFiles(dir)
    if (files.length === 0) throw new Error(`nothing to publish in ${dir}`)
    const archive = packTarGz(dir, files)

    return this.record(archive, { pkg, meta, publishedBy, state, channel, fileCount: files.length })
  }

  /**
   * Record an archive that arrived from somewhere else. The archive is inspected
   * BEFORE anything is written, so a malformed or path-escaping upload never
   * reaches the storage directory.
   */
  publishArchive(archive, { publishedBy = 'system', state = null, channel = null } = {}) {
    const inspection = inspectArchive(archive)
    if (!inspection.ok) {
      const error = new Error(inspection.detail ?? inspection.code)
      error.code = inspection.code
      throw error
    }
    return this.record(archive, {
      pkg: inspection.pkg,
      meta: inspection.meta,
      publishedBy,
      state,
      channel,
      fileCount: inspection.files.length,
      via: 'upload',
    })
  }

  /** Shared tail of both publish paths: validate identity, write bytes, upsert row. */
  record(archive, { pkg, meta, publishedBy, state, channel, fileCount, via = 'directory' }) {
    if (!pkg?.name || !pkg?.version) throw new Error('package.json needs name and version')
    if (!NAME_RE.test(pkg.name)) throw new Error(`invalid package name: ${pkg.name}`)
    // Rejected here rather than at read time: an artifact that cannot be ORDERED cannot
    // be offered as an update, and a version that is not semver has no defined order.
    // Failing the publish keeps that out of the market instead of degrading the catalog.
    if (parseVersion(pkg.version) === null) {
      throw new Error(`package.json version "${pkg.version}" is not a semantic version (expected MAJOR.MINOR.PATCH[-prerelease])`)
    }

    const name = pkg.name
    const version = pkg.version
    const resolvedChannel = channel ?? meta.channel ?? 'stable'
    const resolvedState = state ?? meta.state ?? 'published'
    if (!ARTIFACT_STATES.includes(resolvedState)) {
      throw new Error(`unknown state "${resolvedState}" (expected one of ${ARTIFACT_STATES.join(', ')})`)
    }

    const digest = sha256(archive)
    const target = this.contain(name, version, `${resolvedChannel}.tgz`)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, archive)

    this.db
      .prepare(
        `INSERT INTO artifacts (name, version, channel, state, owner, summary, dsh_range,
                                permissions, sha256, size_bytes, stored_path, published_at, published_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, version, channel) DO UPDATE SET
           state = excluded.state, owner = excluded.owner, summary = excluded.summary,
           dsh_range = excluded.dsh_range, permissions = excluded.permissions,
           sha256 = excluded.sha256, size_bytes = excluded.size_bytes,
           stored_path = excluded.stored_path, published_at = excluded.published_at,
           published_by = excluded.published_by`,
      )
      .run(
        name,
        version,
        resolvedChannel,
        resolvedState,
        meta.owner ?? pkg.dsh?.market?.owner ?? '',
        meta.summary ?? pkg.description ?? '',
        meta.dsh ?? pkg.dsh?.peer ?? '',
        JSON.stringify(Array.isArray(meta.permissions) ? meta.permissions : []),
        digest,
        archive.length,
        target,
        Date.now(),
        publishedBy,
      )

    this.db
      .prepare('INSERT INTO audit (at, action, username, detail) VALUES (?, ?, ?, ?)')
      .run(
        Date.now(),
        'artifact.publish',
        publishedBy,
        JSON.stringify({
          name,
          version,
          channel: resolvedChannel,
          state: resolvedState,
          sha256: digest,
          files: fileCount,
          via,
        }),
      )

    return this.get(name, version, resolvedChannel)
  }

  // --------------------------------------------------------------------- read

  get(name, version, channel = 'stable') {
    return rowToArtifact(
      this.db
        .prepare('SELECT * FROM artifacts WHERE name = ? AND version = ? AND channel = ?')
        .get(name, version, channel),
    )
  }

  /**
   * Highest installable version of a name, optionally pinned to a channel.
   *
   * Ordering happens in JS via `compareVersions`, NOT in SQL: SQLite cannot order
   * semantic versions (`ORDER BY version DESC` puts 1.9.0 above 1.10.0), and the old
   * `ORDER BY published_at DESC` put a freshly published 1.0.0 above 2.0.0.
   *
   * Only `published` artifacts participate, so a revoked newest version cannot be
   * reported as the latest — which previously produced an 「更新到 X」 button that
   * `policy` then refused with `E_REVOKED`.
   */
  latest(name, channel = null) {
    const rows = channel
      ? this.db.prepare('SELECT * FROM artifacts WHERE name = ? AND channel = ?').all(name, channel)
      : this.db.prepare('SELECT * FROM artifacts WHERE name = ?').all(name)
    return this.highest(rows)
  }

  /** The highest-versioned publishable artifact among raw rows, or undefined. */
  highest(rows) {
    let best = null
    for (const row of rows) {
      if (row.state !== PUBLISHABLE) continue
      if (parseVersion(row.version) === null) continue
      if (best === null || compareVersions(row.version, best.version) > 0) best = row
    }
    return rowToArtifact(best)
  }

  /**
   * One row per plugin name — its highest publishable version — which is what the
   * catalog shows and therefore what drives every 「更新到 X」 button.
   */
  catalogRows() {
    const rows = this.db.prepare('SELECT * FROM artifacts').all()
    const byName = new Map()
    for (const row of rows) {
      const list = byName.get(row.name)
      if (list === undefined) byName.set(row.name, [row])
      else list.push(row)
    }
    const out = []
    for (const [, list] of byName) {
      const best = this.highest(list)
      if (best !== null && best !== undefined) out.push(best)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Every version of a name, oldest first — for auditing, including non-published. */
  listVersions(name) {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE name = ?')
      .all(name)
      .map(rowToArtifact)
      .sort((a, b) => compareVersions(a.version, b.version))
  }

  setState(name, version, channel, state) {
    if (!ARTIFACT_STATES.includes(state)) return false
    const result = this.db
      .prepare('UPDATE artifacts SET state = ? WHERE name = ? AND version = ? AND channel = ?')
      .run(state, name, version, channel)
    return Number(result.changes) > 0
  }

  /** Read the stored bytes back and confirm they still hash to what we published. */
  readVerified(artifact) {
    const path = this.contain(artifact.name, artifact.version, `${artifact.channel}.tgz`)
    if (!existsSync(path)) return { ok: false, code: 'E_ARCHIVE_MISSING', path }
    const bytes = readFileSync(path)
    const actual = sha256(bytes)
    if (actual !== artifact.sha256) {
      this.db
        .prepare('INSERT INTO audit (at, action, username, detail) VALUES (?, ?, ?, ?)')
        .run(
          Date.now(),
          'artifact.corrupt',
          null,
          JSON.stringify({ name: artifact.name, version: artifact.version, expected: artifact.sha256, actual }),
        )
      return { ok: false, code: 'E_HASH_MISMATCH', path, actual }
    }
    return { ok: true, bytes, path }
  }

  sizeOf(artifact) {
    try {
      return statSync(this.contain(artifact.name, artifact.version, `${artifact.channel}.tgz`)).size
    } catch {
      return 0
    }
  }
}

export { ArchiveError, extractTarGz } from './pack.js'
