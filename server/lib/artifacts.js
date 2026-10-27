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
import { PACKAGE_NAME_RE } from './layout.js'
import { ArchiveError, collectFiles, inspectArchive, packTarGzEntries, sha256, synthesiseSkillManifest } from './pack.js'

/**
 * The package-name rule, from the shared module rather than declared a second time.
 *
 * The synthesis path (giving a skill bundle the manifest it lacks) and this check must accept
 * exactly the same set of names, or the service would create an artifact it then refuses to
 * record.
 */
const NAME_RE = PACKAGE_NAME_RE
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
export const MARKETPLACE_NAME = 'dsh-plugin-market-internal'


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
  publishFromDirectory(packageDir, { publishedBy = 'system', state = null, channel = null, name = null, version = null } = {}) {
    const dir = resolve(packageDir)
    const files = collectFiles(dir)
    if (files.length === 0) throw new Error(`nothing to publish in ${dir}`)

    /**
     * A directory holding only a SKILL.md is a valid skill bundle.
     *
     * The service synthesises the manifest for an upload; the CLI has to do the same for a
     * directory, or `publish --dir <技能目录>` would fail where the console succeeds — the
     * two entry points disagreeing about what a publishable thing is.
     */
    let entries = new Map(files.map((relative) => [relative, readFileSync(join(dir, relative))]))
    if (!entries.has('package.json')) {
      const made = synthesiseSkillManifest(entries, { name, version })
      if (made !== null) {
        if (made.ok === false) {
          const error = new Error(made.detail)
          error.code = made.code
          throw error
        }
        entries = made.entries
      } else {
        throw new Error(`no package.json in ${dir}`)
      }
    }
    const archive = packTarGzEntries(entries)

    /**
     * Inspect the packed archive rather than trusting the directory.
     *
     * This path used to skip `inspectArchive` entirely, so it was STRICTER on upload than on
     * the CLI: a bundle whose `dsh.bundle.patch` file was missing, or a skill without
     * `SKILL.md`, could be published from disk and refused as an upload. Two publish paths
     * that disagree about what a valid package is will eventually ship one of each.
     */
    const inspection = inspectArchive(archive)
    if (!inspection.ok) {
      const error = new Error(inspection.detail ?? inspection.code)
      error.code = inspection.code
      throw error
    }

    return this.record(archive, {
      // From the INSPECTION, not a second read of the directory: after synthesis the archive
      // is the authority on its own manifest.
      pkg: inspection.pkg,
      meta: inspection.meta,
      kind: inspection.kind,
      publishedBy,
      state,
      channel,
      fileCount: files.length,
    })
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
      kind: inspection.kind,
      publishedBy,
      state,
      channel,
      fileCount: inspection.files.length,
      via: 'upload',
    })
  }

  /** Shared tail of both publish paths: validate identity, write bytes, upsert row. */
  record(archive, { pkg, meta, kind = 'plugin', publishedBy, state, channel, fileCount, via = 'directory' }) {
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
                                permissions, sha256, size_bytes, stored_path, published_at, published_by, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, version, channel) DO UPDATE SET
           state = excluded.state, owner = excluded.owner, summary = excluded.summary,
           dsh_range = excluded.dsh_range, permissions = excluded.permissions,
           sha256 = excluded.sha256, size_bytes = excluded.size_bytes,
           stored_path = excluded.stored_path, published_at = excluded.published_at,
           published_by = excluded.published_by, kind = excluded.kind`,
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
        kind,
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

  /**
   * The highest-versioned artifaact that may still be DISTRIBUTED, or null.
   *
   * Two things disqualify a row, and they are separate axes:
   *
   *  - `state !== published` — not published.
   *  - `recalled` — the service has asked clients to remove it, so offering it again (and
   *    pointing an 「更新到 X」 button at it) would contradict the recall.
   *
   * Skipping recalled rows here is what keeps recall from being MORE visible than revocation:
   * a revoked-only name is absent from the catalog, and a recalled one must be too.
   * `adminRows()` deliberately does not filter either — the console has to see both to change
   * them back.
   */
  highest(rows) {
    let best = null
    for (const row of rows) {
      if (row.state !== PUBLISHABLE) continue
      // A recalled version must not be advertised or offered as an update.
      if (row.recalled === 1) continue
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
    const out = []
    for (const [, list] of this.rowsByName()) {
      const best = this.highest(list)
      if (best !== null && best !== undefined) out.push(best)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * One row per name — its highest version REGARDLESS of state. The management view.
   *
   * `catalogRows()` drops any name whose versions are all non-publishable. That is exactly
   * right for the client catalog — a revoked artifact must never be offered — and exactly
   * wrong for the console, because the artifact an operator most needs to act on is the one
   * they JUST revoked, and it disappeared from the only screen that could change it back.
   *
   * A draft-only artifact had the same fate, which is worse: a draft could never be promoted,
   * and a review-only artifact could never be approved.
   *
   * Ordering still needs a valid semver — that is what "highest" means — but state is not a
   * filter here.
   */
  adminRows() {
    const out = []
    for (const [, list] of this.rowsByName()) {
      const best = this.highestAny(list)
      if (best !== null && best !== undefined) out.push(best)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Raw rows grouped by name, so both row views share one grouping. */
  rowsByName() {
    const byName = new Map()
    for (const row of this.db.prepare('SELECT * FROM artifacts').all()) {
      const list = byName.get(row.name)
      if (list === undefined) byName.set(row.name, [row])
      else list.push(row)
    }
    return byName
  }

  /** The highest-versioned row of ANY state among raw rows, or null. */
  highestAny(rows) {
    let best = null
    for (const row of rows) {
      // The version must still be orderable; unlike `highest`, the state is irrelevant.
      if (parseVersion(row.version) === null) continue
      if (best === null || compareVersions(row.version, best.version) > 0) best = row
    }
    return rowToArtifact(best)
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

  /**
   * Mark (or unmark) a version as recalled: "remove it from the machines that have it".
   *
   * Deliberately NOT a state. `setState('revoked')` stops distribution and leaves installed
   * copies alone — right for "pull it while I fix it". Recall is the other intent, the security
   * one, and folding it into `revoked` would make a temporary withdrawal erase everybody's
   * install.
   *
   * Recall implies "do not distribute" too; `policy` enforces that separately.
   *
   * `version === '*'` recalls EVERY row of that name, across channels — "this plugin as a whole
   * is bad". It is a SNAPSHOT, not a standing rule: the rows that exist now are marked, and a
   * version published afterwards is NOT recalled. That is the property that makes the action
   * usable — the usual reason to pull a whole series is a bad build, and the rebuilt release has
   * to be able to go out without first cancelling the recall (a recall also blocks distribution,
   * so a rule would silently make the fix uninstallable).
   *
   * Returns the number of rows changed. A batch that matched nothing must not look like a
   * successful recall, and the console reports the count back to the operator.
   */
  setRecalled(name, version, channel, recalled) {
    const at = recalled ? Date.now() : null
    const result = version === '*'
      ? this.db
        .prepare('UPDATE artifacts SET recalled = ?, recalled_at = ? WHERE name = ?')
        .run(recalled ? 1 : 0, at, name)
      : this.db
        .prepare('UPDATE artifacts SET recalled = ?, recalled_at = ? WHERE name = ? AND version = ? AND channel = ?')
        .run(recalled ? 1 : 0, at, name, version, channel)
    return Number(result.changes)
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
