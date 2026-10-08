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
 * Version ordering lives in `version.js` so the client plugin compares versions exactly
 * the way the service does — the client decides whether the service carries a newer copy
 * of the market plugin itself, and two implementations would eventually disagree.
 * See that file for why ordering has to be done in JS at all.
 */
import { compareVersions, parseVersion } from './version.js'

export { compareVersions, parseVersion }

/** Only an artifact in this state may be installed (mirrors `policy.js`). */
const PUBLISHABLE = 'published'

/** The package name of the market's own client plugin. */
export const MARKETPLACE_NAME = 'dsh-plugin-marketplace'


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

  // ------------------------------------------------- the market's own package
  //
  // Kept OUT of the artifacts table on purpose. It is not market data: it is not
  // governed by `policy`, it does not appear in the catalog, and it is not something a
  // group is granted. It is the client that talks to this service, and mixing it into
  // the catalog would let it be "installed" through a path whose format it cannot even
  // use. One file on disk plus one small descriptor is the whole feature.

  get selfDir() {
    return this.contain('self')
  }

  get selfFile() {
    return join(this.selfDir, 'marketplace.tgz')
  }

  get selfMetaFile() {
    return join(this.selfDir, 'marketplace.json')
  }

  /**
   * Stage the market plugin package this service will hand out.
   *
   * Validated before anything is written: a corrupt or mislabelled archive must never
   * become the copy every client downloads, because a failed self-update on every
   * machine at once is the worst possible failure mode here.
   */
  stageMarketplacePackage(archive) {
    const inspection = inspectArchive(archive)
    if (!inspection.ok) throw new ArchiveError(inspection.detail ?? inspection.code)
    const pkg = inspection.pkg
    if (pkg.name !== MARKETPLACE_NAME) {
      throw new ArchiveError(`期望 ${MARKETPLACE_NAME}，归档声明的是 ${pkg.name}`)
    }
    if (parseVersion(pkg.version) === null) {
      throw new ArchiveError(`version "${pkg.version}" is not a semantic version`)
    }
    mkdirSync(this.selfDir, { recursive: true })
    writeFileSync(this.selfFile, archive)
    const meta = {
      name: pkg.name,
      version: pkg.version,
      sha256: sha256(archive),
      sizeBytes: archive.length,
      publishedAt: Date.now(),
    }
    writeFileSync(this.selfMetaFile, JSON.stringify(meta, null, 2))
    return meta
  }

  /** The staged package's descriptor, or `null` when none has been staged. */
  marketplacePackage() {
    if (!existsSync(this.selfMetaFile) || !existsSync(this.selfFile)) return null
    try {
      const meta = JSON.parse(readFileSync(this.selfMetaFile, 'utf8'))
      if (parseVersion(meta.version) === null) return null
      return meta
    } catch {
      // A damaged descriptor means "no package", not a crash: the client falls back to
      // running whatever it already has.
      return null
    }
  }

  /** The staged bytes, re-hashed so the service cannot hand out different content. */
  marketplaceBytes() {
    const meta = this.marketplacePackage()
    if (meta === null) return null
    const bytes = readFileSync(this.selfFile)
    if (sha256(bytes) !== meta.sha256) return null
    return bytes
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
