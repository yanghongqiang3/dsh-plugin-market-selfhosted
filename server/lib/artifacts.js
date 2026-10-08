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

  /** Newest version of a name, optionally pinned to a channel. */
  latest(name, channel = null) {
    const row = channel
      ? this.db
          .prepare('SELECT * FROM artifacts WHERE name = ? AND channel = ? ORDER BY published_at DESC LIMIT 1')
          .get(name, channel)
      : this.db
          .prepare('SELECT * FROM artifacts WHERE name = ? ORDER BY published_at DESC LIMIT 1')
          .get(name)
    return rowToArtifact(row)
  }

  /** One row per plugin name — its newest version — which is what the catalog shows. */
  catalogRows() {
    return this.db
      .prepare(
        `SELECT a.* FROM artifacts a
         JOIN (SELECT name, MAX(published_at) AS newest FROM artifacts GROUP BY name) m
           ON m.name = a.name AND m.newest = a.published_at
         ORDER BY a.name`,
      )
      .all()
      .map(rowToArtifact)
  }

  listVersions(name) {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE name = ? ORDER BY published_at DESC')
      .all(name)
      .map(rowToArtifact)
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
