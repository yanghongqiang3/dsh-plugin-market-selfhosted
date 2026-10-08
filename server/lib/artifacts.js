/**
 * Market server — artifact storage.
 *
 * One artifact is a gzipped tar of the plugin package directory, stored under
 * `<dataDir>/artifacts/<name>/<version>/<channel>.tgz`. The sha256 recorded at
 * publish time is the installer's integrity check on the way back out, so the
 * server cannot silently serve different bytes than it advertised.
 *
 * Publishing reads a `market.json` beside the package's package.json:
 *
 *   { "summary": "...", "owner": "billing", "channel": "stable",
 *     "dsh": ">=0.2.0-rc.2 <0.3", "permissions": ["tools"], "state": "published" }
 *
 * Absent fields fall back to the package.json and to `published`.
 */
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { rowToArtifact } from './db.js'

const NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/

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

  /**
   * Tar up a package directory and record it. Idempotent per (name, version,
   * channel): republishing the same bytes updates metadata, different bytes
   * replace the stored archive and the hash together.
   */
  publishFromDirectory(packageDir, { publishedBy = 'system', state = null, channel = null } = {}) {
    const dir = resolve(packageDir)
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) throw new Error(`no package.json in ${dir}`)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!pkg.name || !pkg.version) throw new Error('package.json needs name and version')
    if (!NAME_RE.test(pkg.name)) throw new Error(`invalid package name: ${pkg.name}`)

    const marketPath = join(dir, 'market.json')
    const meta = existsSync(marketPath) ? JSON.parse(readFileSync(marketPath, 'utf8')) : {}

    const name = pkg.name
    const version = pkg.version
    const resolvedChannel = channel ?? meta.channel ?? 'stable'
    const resolvedState = state ?? meta.state ?? 'published'
    const summary = meta.summary ?? pkg.description ?? ''
    const owner = meta.owner ?? ''
    const dshRange = meta.dsh ?? pkg.dsh?.peer ?? ''
    const permissions = Array.isArray(meta.permissions) ? meta.permissions : []

    const files = collect(dir)
    if (files.length === 0) throw new Error(`nothing to publish in ${dir}`)
    const archive = tarGz(dir, files)
    const sha256 = createHash('sha256').update(archive).digest('hex')

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
        owner,
        summary,
        dshRange,
        JSON.stringify(permissions),
        sha256,
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
        JSON.stringify({ name, version, channel: resolvedChannel, state: resolvedState, sha256, files: files.length }),
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

  /** Newest published version of a name (channel-aware), else newest of any state. */
  latest(name, channel = null) {
    const row = channel
      ? this.db
          .prepare(
            `SELECT * FROM artifacts WHERE name = ? AND channel = ?
             ORDER BY published_at DESC LIMIT 1`,
          )
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
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== artifact.sha256) {
      this.db
        .prepare('INSERT INTO audit (at, action, username, detail) VALUES (?, ?, ?, ?)')
        .run(Date.now(), 'artifact.corrupt', null, JSON.stringify({ name: artifact.name, version: artifact.version, expected: artifact.sha256, actual }))
      return { ok: false, code: 'E_HASH_MISMATCH', path, actual }
    }
    return { ok: true, bytes, path }
  }

  streamOf(artifact) {
    return createReadStream(this.contain(artifact.name, artifact.version, `${artifact.channel}.tgz`))
  }

  sizeOf(artifact) {
    try {
      return statSync(this.contain(artifact.name, artifact.version, `${artifact.channel}.tgz`)).size
    } catch {
      return 0
    }
  }
}

// ------------------------------------------------------------------ tar writer

/** Deterministic tar: fixed mtime and sorted entries, so the same tree hashes alike. */
function tarGz(root, files) {
  const blocks = []
  for (const relative of [...files].sort()) {
    const absolute = join(root, relative)
    const data = readFileSync(absolute)
    blocks.push(tarHeader(relative, data.length), data, padding(data.length))
  }
  blocks.push(Buffer.alloc(1024)) // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

function collect(root, prefix = '', out = []) {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    if (entry.isDirectory()) collect(root, relative, out)
    else if (entry.isFile()) out.push(relative)
  }
  return out
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512)
  const write = (offset, length, value) => header.write(value, offset, length, 'utf8')
  const nameBytes = Buffer.byteLength(name)
  if (nameBytes > 100) throw new Error(`path too long for tar: ${name}`)
  write(0, 100, name)
  write(100, 8, '0000644\0') // mode
  write(108, 8, '0000000\0') // uid
  write(116, 8, '0000000\0') // gid
  write(124, 12, `${size.toString(8).padStart(11, '0')}\0`)
  write(136, 12, '00000000000\0') // mtime fixed at 0 for determinism
  write(148, 8, '        ') // checksum placeholder
  header.write('0', 156, 1, 'utf8') // regular file
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  write(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function padding(size) {
  const remainder = size % 512
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - remainder)
}

/** Used by tests to prove an archive round-trips. */
export function extractTarGz(buffer) {
  const tar = gunzipSync(buffer)
  const files = new Map()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8)
    const start = offset + 512
    files.set(name, tar.subarray(start, start + size))
    offset = start + size + ((512 - (size % 512)) % 512)
  }
  return files
}
