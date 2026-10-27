/**
 * Market server — store: every read and write against the database.
 *
 * The store owns accounts, groups, grants, sessions, device authorizations and
 * the audit log. It performs no authorization itself; `policy.js` does that, and
 * the HTTP layer is the only caller of either.
 */
import {
  LOCKOUT_MS,
  LOCKOUT_THRESHOLD,
  REFRESH_TTL_MS,
  SESSION_TTL_MS,
  hashPassword,
  hashToken,
  newId,
  newToken,
  verifyPassword,
} from './crypto.js'
import { rowToUser } from './db.js'

export const DEFAULT_ADMIN = { username: 'admin', password: 'dsh-admin' }

/** Hard ceiling on a page, so a stray `limit=100000` cannot be used to dump a table. */
export const MAX_PAGE_SIZE = 200
export const DEFAULT_PAGE_SIZE = 20

/**
 * Slice a list into a page, clamped to sane bounds.
 *
 * Every admin list goes through this, so `limit`/`offset` behave identically everywhere
 * and an out-of-range offset yields an empty page rather than an error — the console has
 * to be able to ask for page 9 of a list that shrank to 2 pages while it was open.
 */
export function paginate(rows, limit, offset) {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE))
  const from = Math.max(0, Number(offset) || 0)
  return {
    entries: rows.slice(from, from + size),
    total: rows.length,
    limit: size,
    offset: from,
  }
}

export class Store {
  constructor(db) {
    this.db = db
  }

  // -------------------------------------------------------------------- audit

  audit(action, detail = {}, username = null) {
    try {
      this.db
        .prepare('INSERT INTO audit (at, action, username, detail) VALUES (?, ?, ?, ?)')
        .run(Date.now(), action, username, JSON.stringify(detail))
    } catch {
      /* auditing must never break a request */
    }
  }

  recentAudit(limit = 200) {
    return this.db
      .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ ...row, detail: safeParse(row.detail) }))
  }

  // -------------------------------------------------------- installed inventory

  /**
   * Replace the inventory one device says it has.
   *
   * The report is a SNAPSHOT, not a delta. That is what lets one route carry installs,
   * uninstalls and recall removals: an item missing from the report is gone. It is also why
   * the device id is load-bearing — with one row per account, a report from machine B would
   * delete machine A's items.
   *
   * Added / removed / updated are returned for diagnostics and for the client's log; the
   * authoritative answer to "what is installed" is always the table, not those counts.
   */
  reportInstalled({ username, deviceId, profile = null, items = [] }) {
    const at = Date.now()
    const before = new Map(
      this.db.prepare('SELECT name, version FROM install_items WHERE device_id = ?').all(deviceId)
        .map((row) => [row.name, row.version ?? null]),
    )
    const next = new Map(items.map((item) => [item.name, item]))
    const added = [...next.keys()].filter((name) => !before.has(name))
    const removed = [...before.keys()].filter((name) => !next.has(name))
    const updated = [...next.entries()]
      .filter(([name, item]) => before.has(name) && before.get(name) !== (item.version ?? null))
      .map(([name]) => name)

    this.db.exec('BEGIN')
    try {
      this.db.prepare(`
        INSERT INTO install_devices (device_id, username, profile, item_count, reported_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          username = excluded.username,
          profile = excluded.profile,
          item_count = excluded.item_count,
          reported_at = excluded.reported_at
      `).run(deviceId, username, profile, next.size, at)
      this.db.prepare('DELETE FROM install_items WHERE device_id = ?').run(deviceId)
      const insert = this.db.prepare(
        'INSERT INTO install_items (device_id, name, version, kind, reported_at) VALUES (?, ?, ?, ?, ?)',
      )
      for (const item of next.values()) {
        insert.run(deviceId, item.name, item.version ?? null, item.kind ?? 'plugin', at)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { deviceId, username, installed: next.size, added, removed, updated }
  }

  /** Global figures for the statistics header: who reported, how much, and total downloads. */
  installCoverage() {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM install_devices) AS devices,
        (SELECT COUNT(DISTINCT username) FROM install_devices) AS accounts,
        (SELECT COUNT(*) FROM install_items) AS items,
        (SELECT MAX(reported_at) FROM install_devices) AS last_reported_at,
        (SELECT COUNT(*) FROM audit WHERE action = 'download') AS downloads
    `).get()
    return {
      devices: Number(row.devices ?? 0),
      accounts: Number(row.accounts ?? 0),
      items: Number(row.items ?? 0),
      lastReportedAt: row.last_reported_at ?? null,
      downloads: Number(row.downloads ?? 0),
    }
  }

  /**
   * Which accounts currently have one plugin, for the click-through on 安装人数.
   *
   * Same data as the account dimension, read from the other end: one row per account, with
   * the versions/devices that account reported. Account-deduplicated on purpose — the count
   * on screen is people, and this list must be the same people.
   */
  installedAccountsOf(name) {
    return this.db.prepare(`
      SELECT d.username,
             u.display_name AS displayName,
             b.dsh_user_id AS dshUserId,
             GROUP_CONCAT(DISTINCT i.version) AS versions,
             COUNT(DISTINCT d.device_id) AS devices,
             MAX(i.reported_at) AS reportedAt
      FROM install_items i
      JOIN install_devices d ON d.device_id = i.device_id
      LEFT JOIN users u ON u.username = d.username
      LEFT JOIN dsh_bindings b ON b.market_username = d.username
      WHERE i.name = ?
      GROUP BY d.username
      ORDER BY d.username
    `).all(name).map((row) => ({
      username: row.username,
      displayName: row.displayName,
      dshUserId: row.dshUserId,
      versions: String(row.versions ?? '').split(',').filter(Boolean),
      devices: Number(row.devices ?? 0),
      reportedAt: row.reportedAt,
    }))
  }

  /** One account's plugins, aggregated across every device it reported. */
  installedItemsOf(username) {
    return this.db.prepare(`
      SELECT i.name,
             i.kind,
             GROUP_CONCAT(DISTINCT i.version) AS versions,
             COUNT(DISTINCT i.device_id) AS devices,
             MAX(i.reported_at) AS reported_at
      FROM install_items i
      JOIN install_devices d ON d.device_id = i.device_id
      WHERE d.username = ?
      GROUP BY i.name, i.kind
      ORDER BY i.name
    `).all(username).map((row) => ({
      name: row.name,
      kind: row.kind,
      versions: String(row.versions ?? '').split(',').filter(Boolean),
      devices: Number(row.devices ?? 0),
      reportedAt: row.reported_at,
    }))
  }

  /**
   * Account dimension: which account installed which plugins.
   *
   * Only accounts with at least one installed item appear. An account with no report is
   * absent — which is honest: the service does not know, and pretending it has zero installs
   * would read as "this person installed nothing" instead of "this person has not reported".
   */
  listInstallsByAccount({ limit = DEFAULT_PAGE_SIZE, offset = 0, q = '', usernames = null } = {}) {
    const needle = String(q ?? '').trim().toLowerCase()
    const wanted = Array.isArray(usernames) && usernames.length > 0 ? new Set(usernames) : null
    let rows = this.db.prepare(`
      SELECT d.username,
             u.display_name AS displayName,
             b.dsh_user_id AS dshUserId,
             COUNT(DISTINCT d.device_id) AS deviceCount,
             COUNT(DISTINCT i.name) AS pluginCount,
             MAX(d.reported_at) AS lastReportedAt
      FROM install_devices d
      JOIN install_items i ON i.device_id = d.device_id
      LEFT JOIN users u ON u.username = d.username
      LEFT JOIN dsh_bindings b ON b.market_username = d.username
      GROUP BY d.username
      ORDER BY pluginCount DESC, d.username
    `).all().map((row) => ({ ...row, items: this.installedItemsOf(row.username) }))
    if (wanted !== null) rows = rows.filter((account) => wanted.has(account.username))
    const filtered = needle === ''
      ? rows
      : rows.filter((account) =>
        [account.username, account.displayName ?? '', ...account.items.map((item) => item.name)]
          .some((field) => String(field).toLowerCase().includes(needle)))
    return paginate(filtered, limit, offset)
  }

  /**
   * Plugin dimension: how many PEOPLE have it (distinct accounts), on how many devices, and
   * how many downloads the service has served in total.
   *
   * The name universe is the union of current installs and past downloads, so a plugin that
   * everyone uninstalled still shows its download count instead of disappearing. Downloads
   * come from the audit log and therefore include updates and retries — they are not a
   * lower bound on installs, but they are what the service itself actually served.
   */
  listInstallsByPlugin({ limit = DEFAULT_PAGE_SIZE, offset = 0, q = '' } = {}) {
    const needle = String(q ?? '').trim().toLowerCase()
    const entries = this.allPluginInstallStats()
    const filtered = needle === ''
      ? entries
      : entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    return paginate(filtered, limit, offset)
  }

  /**
   * The same data without paging, so callers can join it onto another list.
   *
   * The console's artifact list is paged by artifact NAME, so asking this table for a page of
   * its own would line up two different orders. The artifact rows are tens, not thousands;
   * building the map once and looking up each row is both simpler and correct.
   */
  allPluginInstallStats() {
    const downloads = new Map(
      this.db.prepare(`
        SELECT json_extract(detail, '$.name') AS name,
               COUNT(*) AS downloads,
               MAX(at) AS lastDownloadAt
        FROM audit
        WHERE action = 'download' AND json_extract(detail, '$.name') IS NOT NULL
        GROUP BY name
      `).all().map((row) => [row.name, row]),
    )
    const installed = new Map(
      this.db.prepare(`
        SELECT i.name,
               COUNT(DISTINCT d.username) AS installers,
               COUNT(DISTINCT i.device_id) AS devices,
               GROUP_CONCAT(DISTINCT i.version) AS versions,
               MAX(i.reported_at) AS lastInstalledAt
        FROM install_items i
        JOIN install_devices d ON d.device_id = i.device_id
        GROUP BY i.name
      `).all().map((row) => [row.name, row]),
    )
    const entries = [...new Set([...downloads.keys(), ...installed.keys()])]
      .filter((name) => typeof name === 'string' && name !== '')
      .map((name) => {
        const current = installed.get(name)
        const served = downloads.get(name)
        return {
          name,
          installers: Number(current?.installers ?? 0),
          devices: Number(current?.devices ?? 0),
          downloads: Number(served?.downloads ?? 0),
          versions: String(current?.versions ?? '').split(',').filter(Boolean),
          lastInstalledAt: current?.lastInstalledAt ?? null,
          lastDownloadAt: served?.lastDownloadAt ?? null,
        }
      })
    // People first, then reach (downloads), then a stable name order.
    entries.sort((a, b) => b.installers - a.installers || b.downloads - a.downloads || a.name.localeCompare(b.name))
    return entries
  }

  // -------------------------------------------------------------------- users

  findUser(username) {
    return rowToUser(this.db.prepare('SELECT * FROM users WHERE username = ?').get(username))
  }

  findUserById(id) {
    return rowToUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id))
  }

  listUsers() {
    return this.db
      .prepare('SELECT * FROM users ORDER BY created_at')
      .all()
      .map((row) => this.decorate(rowToUser(row)))
  }

  /**
   * One page of users, with the fields the search box is expected to match.
   *
   * Pagination happens HERE rather than in the SQL, because `decorate` already has to
   * read every user's groups — doing that per page would be N+1 queries for the same
   * answer. The admin tables are small (tens to hundreds of rows), so the cost of
   * listing them is the group lookups, not the scan.
   *
   * Paging client-side was the alternative and was rejected: the browser would hold the
   * whole table, and every future filter would have to re-implement the same slicing.
   */
  listUsersPage({ limit = 20, offset = 0, q = '' } = {}) {
    const needle = String(q ?? '').trim().toLowerCase()
    let rows = this.listUsers()
    if (needle !== '') {
      rows = rows.filter((user) =>
        [user.username, user.displayName ?? '', user.role, user.status]
          .some((field) => String(field).toLowerCase().includes(needle)))
    }
    return paginate(rows, limit, offset)
  }

  /** Adds the fields the admin UI shows without a second round trip. */
  decorate(user) {
    if (!user) return null
    return { ...user, groups: this.groupsOf(user.username).map((group) => group.id) }
  }

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  }

  createUser({ username, password, displayName, role = 'member', mustChangePassword = true, createdBy = 'system' }) {
    if (!username) throw new Error('username required')
    if (!password) throw new Error('password required')
    if (this.findUser(username)) throw new Error(`user ${username} already exists`)
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, role, status, password_hash,
                            must_change_password, created_at, created_by)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        id,
        username,
        displayName || username,
        role === 'admin' ? 'admin' : 'member',
        hashPassword(password),
        mustChangePassword ? 1 : 0,
        Date.now(),
        createdBy,
      )
    this.audit('user.create', { username, role, createdBy }, createdBy)
    return this.findUser(username)
  }

  setPassword(username, password, { mustChange = false, by = 'system' } = {}) {
    const user = this.findUser(username)
    if (!user) throw new Error(`no such user: ${username}`)
    this.db
      .prepare(
        `UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?,
                          failed_logins = 0, locked_until = NULL
         WHERE username = ?`,
      )
      .run(hashPassword(password), mustChange ? 1 : 0, Date.now(), username)
    this.audit('user.password', { username, mustChange }, by)
    return this.findUser(username)
  }

  setStatus(username, status, { by = 'admin', reason } = {}) {
    const user = this.findUser(username)
    if (!user) throw new Error(`no such user: ${username}`)
    this.db.prepare('UPDATE users SET status = ? WHERE username = ?').run(status, username)
    let revoked = 0
    if (status !== 'active') revoked = this.revokeSessionsOf(user.id)
    this.audit('user.status', { username, status, reason, revokedSessions: revoked }, by)
    return { ...this.findUser(username), revokedSessions: revoked }
  }

  setRole(username, role, { by = 'admin' } = {}) {
    const user = this.findUser(username)
    if (!user) throw new Error(`no such user: ${username}`)
    const next = role === 'admin' ? 'admin' : 'member'
    this.db.prepare('UPDATE users SET role = ? WHERE username = ?').run(next, username)
    this.audit('user.role', { username, role: next }, by)
    return this.findUser(username)
  }

  /**
   * Change the human-facing name. Separate from role and status because it grants
   * nothing and revokes nothing — it is the one editable account field with no
   * consequence, which is exactly why it should not share their code path.
   */
  setDisplayName(username, displayName, { by = 'admin' } = {}) {
    const user = this.findUser(username)
    if (!user) throw new Error(`no such user: ${username}`)
    const next = String(displayName ?? '').trim()
    this.db.prepare('UPDATE users SET display_name = ? WHERE username = ?').run(next, username)
    this.audit('user.displayName', { username, displayName: next }, by)
    return this.findUser(username)
  }

  // ------------------------------------------------------------------- groups

  listGroups() {
    const groups = this.db.prepare('SELECT * FROM groups ORDER BY created_at').all()
    const memberships = this.db.prepare('SELECT username, group_id FROM memberships').all()
    const grants = this.db.prepare('SELECT * FROM grants ORDER BY id').all()
    return groups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      createdAt: group.created_at,
      members: memberships.filter((m) => m.group_id === group.id).map((m) => m.username),
      grants: grants
        .filter((grant) => grant.group_id === group.id)
        .map((grant) => ({
          groupId: grant.group_id,
          pluginPattern: grant.plugin_pattern,
          effect: grant.effect,
          channel: grant.channel,
        })),
    }))
  }

  findGroup(id) {
    return this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) ?? null
  }

  /** One page of groups, optionally filtered. Same shape as `listUsersPage`. */
  listGroupsPage({ limit = 20, offset = 0, q = '' } = {}) {
    const needle = String(q ?? '').trim().toLowerCase()
    let rows = this.listGroups()
    if (needle !== '') {
      rows = rows.filter((group) =>
        [group.id, group.name ?? '', group.description ?? '']
          .some((field) => String(field).toLowerCase().includes(needle)))
    }
    return paginate(rows, limit, offset)
  }

  /**
   * Change a group's description. The ID is the identity and is not editable.
   *
   * Renaming a group is deliberately NOT offered: the ID is what grants and memberships
   * reference, and letting the two drift apart would make every stored rule harder to
   * read. Only the human-facing description changes.
   */
  updateGroup(id, { description = '', by = 'admin' } = {}) {
    const existing = this.findGroup(id)
    if (!existing) throw new Error(`no such group: ${id}`)
    this.db.prepare('UPDATE groups SET description = ? WHERE id = ?').run(description, id)
    this.audit('group.update', { id, description }, by)
    return this.findGroup(id)
  }

  /**
   * Delete a group together with its memberships and grants.
   *
   * The cleanup is explicit because the alternative — leaving rows that reference a
   * group that no longer exists — would make `listGroups` and `policy.evaluate` disagree
   * about whether a rule exists, and a user could keep an install permission that no
   * administrator can see or revoke.
   */
  deleteGroup(id, { by = 'admin' } = {}) {
    const existing = this.findGroup(id)
    if (!existing) throw new Error(`no such group: ${id}`)
    const memberships = this.db.prepare('DELETE FROM memberships WHERE group_id = ?').run(id)
    const grants = this.db.prepare('DELETE FROM grants WHERE group_id = ?').run(id)
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    this.audit('group.delete', {
      id,
      memberships: Number(memberships.changes),
      grants: Number(grants.changes),
    }, by)
    return { id, memberships: Number(memberships.changes), grants: Number(grants.changes) }
  }

  createGroup({ id, name, description = '', by = 'admin' }) {
    if (!id) throw new Error('group id required')
    if (this.findGroup(id)) throw new Error(`group ${id} exists`)
    this.db
      .prepare('INSERT INTO groups (id, name, description, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name || id, description, Date.now())
    this.audit('group.create', { id, name, description }, by)
    return this.findGroup(id)
  }

  groupsOf(username) {
    return this.db
      .prepare(
        `SELECT g.* FROM groups g
         JOIN memberships m ON m.group_id = g.id
         WHERE m.username = ?
         ORDER BY g.created_at`,
      )
      .all(username)
      .map((group) => ({ id: group.id, name: group.name, description: group.description }))
  }

  setMembership(username, groupId, on, { by = 'admin' } = {}) {
    if (!this.findUser(username)) throw new Error(`no such user: ${username}`)
    if (!this.findGroup(groupId)) throw new Error(`no such group: ${groupId}`)
    if (on) {
      this.db
        .prepare('INSERT OR IGNORE INTO memberships (username, group_id, created_at) VALUES (?, ?, ?)')
        .run(username, groupId, Date.now())
    } else {
      this.db.prepare('DELETE FROM memberships WHERE username = ? AND group_id = ?').run(username, groupId)
    }
    this.audit('membership', { username, groupId, on }, by)
    return this.groupsOf(username).map((group) => group.id)
  }

  // ------------------------------------------------------------------- grants

  addGrant({ groupId, pluginPattern, effect = 'allow', channel = null, by = 'admin' }) {
    if (!this.findGroup(groupId)) throw new Error(`no such group: ${groupId}`)
    if (!pluginPattern) throw new Error('pluginPattern required')
    this.db
      .prepare(
        `INSERT INTO grants (group_id, plugin_pattern, effect, channel, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(groupId, pluginPattern, effect === 'deny' ? 'deny' : 'allow', channel, Date.now(), by)
    this.audit('grant.add', { groupId, pluginPattern, effect, channel }, by)
  }

  removeGrant({ groupId, pluginPattern, by = 'admin' }) {
    const result = this.db
      .prepare('DELETE FROM grants WHERE group_id = ? AND plugin_pattern = ?')
      .run(groupId, pluginPattern)
    this.audit('grant.remove', { groupId, pluginPattern, removed: Number(result.changes) }, by)
    return Number(result.changes)
  }

  /** Every rule, flat, with its group — the shape an admin table wants. */
  listGrants() {
    return this.db
      .prepare('SELECT * FROM grants ORDER BY group_id, plugin_pattern')
      .all()
      .map((row) => ({
        groupId: row.group_id,
        pattern: row.plugin_pattern,
        pluginPattern: row.plugin_pattern,
        effect: row.effect,
        channel: row.channel ?? '',
        createdAt: row.created_at,
        createdBy: row.created_by,
      }))
  }

  /** One page of rules, optionally filtered by group, effect or pattern. */
  listGrantsPage({ limit = 20, offset = 0, q = '' } = {}) {
    const needle = String(q ?? '').trim().toLowerCase()
    let rows = this.listGrants()
    if (needle !== '') {
      rows = rows.filter((grant) =>
        [grant.groupId, grant.pattern, grant.effect, grant.channel]
          .some((field) => String(field ?? '').toLowerCase().includes(needle)))
    }
    return paginate(rows, limit, offset)
  }

  /**
   * Change a rule in place.
   *
   * A grant is identified by (group, pattern) — there is no separate id — so "editing" is
   * remove-then-add. Both halves are audited, and the new row is written before the old
   * one is removed only when the pattern is unchanged; when the pattern changes there is
   * nothing to collide with.
   */
  updateGrant({ groupId, pluginPattern, nextPattern = null, effect = 'allow', channel = null, by = 'admin' }) {
    const existing = this.db
      .prepare('SELECT * FROM grants WHERE group_id = ? AND plugin_pattern = ?')
      .get(groupId, pluginPattern)
    if (!existing) throw new Error(`no such grant: ${groupId} / ${pluginPattern}`)
    const pattern = String(nextPattern ?? pluginPattern)
    if (!pattern) throw new Error('pluginPattern required')
    if (pattern !== pluginPattern) {
      this.db.prepare('DELETE FROM grants WHERE group_id = ? AND plugin_pattern = ?').run(groupId, pluginPattern)
      this.addGrant({ groupId, pluginPattern: pattern, effect, channel, by })
    } else {
      this.db
        .prepare('UPDATE grants SET effect = ?, channel = ? WHERE group_id = ? AND plugin_pattern = ?')
        .run(effect === 'deny' ? 'deny' : 'allow', channel, groupId, pluginPattern)
      this.audit('grant.update', { groupId, pluginPattern, effect, channel }, by)
    }
    return { groupId, pattern, effect, channel }
  }

  /** Grants belonging to any of the caller's groups, for one plugin name. */
  grantsFor(groups, name) {
    if (groups.length === 0) return []
    const placeholders = groups.map(() => '?').join(',')
    return this.db
      .prepare(`SELECT * FROM grants WHERE group_id IN (${placeholders})`)
      .all(...groups.map((group) => group.id))
      .filter((grant) => matches(grant.plugin_pattern, name))
      .map((grant) => ({
        groupId: grant.group_id,
        pluginPattern: grant.plugin_pattern,
        effect: grant.effect,
        channel: grant.channel,
      }))
  }

  // ----------------------------------------------------------------- sessions

  issueSession(user, { ip = null, userAgent = null } = {}) {
    const token = newToken()
    const refresh = newToken()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, username, token_hash, refresh_hash, issued_at,
                               expires_at, refresh_expires_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        user.id,
        user.username,
        hashToken(token),
        hashToken(refresh),
        now,
        now + SESSION_TTL_MS,
        now + REFRESH_TTL_MS,
        ip,
        userAgent,
      )
    return { token, refresh, expiresIn: SESSION_TTL_MS / 1000 }
  }

  /** Re-check the account on every call: a disabled user loses access immediately. */
  resolveSession(token) {
    if (!token) return null
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE token_hash = ?')
      .get(hashToken(token))
    if (!row || row.revoked_at !== null) return null
    if (row.expires_at < Date.now()) return null
    const user = this.findUserById(row.user_id)
    if (!user || user.status !== 'active') return null
    return { user, session: row, mustChangePassword: user.mustChangePassword }
  }

  revokeSession(token) {
    const result = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(Date.now(), hashToken(token))
    return Number(result.changes) > 0
  }

  revokeSessionsOf(userId) {
    const result = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(Date.now(), userId)
    return Number(result.changes)
  }

  /** Housekeeping: drop expired sessions. */
  prune() {
    const now = Date.now()
    const sessions = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
    return { sessions: Number(sessions.changes) }
  }

  // -------------------------------------------------------------- auth check

  /**
   * Verify credentials and hand back the user, or a reason.
   * Lockout is tracked per account so a brute force cannot rotate IPs freely.
   */
  authenticate(username, password) {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username)
    if (!row) return { ok: false, code: 'E_BAD_CREDENTIALS' }
    const user = rowToUser(row)
    if (user.lockedUntil && user.lockedUntil > Date.now()) return { ok: false, code: 'E_LOCKED' }
    if (!verifyPassword(password, row.password_hash)) {
      const failed = user.failedLogins + 1
      const lockedUntil = failed >= LOCKOUT_THRESHOLD ? Date.now() + LOCKOUT_MS : null
      this.db
        .prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE username = ?')
        .run(failed, lockedUntil, username)
      this.audit('login.fail', { username, failed, locked: Boolean(lockedUntil) }, username)
      return { ok: false, code: lockedUntil ? 'E_LOCKED' : 'E_BAD_CREDENTIALS' }
    }
    if (user.status !== 'active') return { ok: false, code: 'E_ACCOUNT_DISABLED' }
    this.db
      .prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE username = ?')
      .run(Date.now(), username)
    this.audit('login.ok', { username }, username)
    return { ok: true, user: this.findUser(username) }
  }

  /**
   * Redeem a refresh token for a new session, rotating both tokens.
   *
   * The refresh token was issued from the first day and stored (`refresh_hash`,
   * `refresh_expires_at`) but NOTHING ever redeemed it, so a session simply died after
   * two hours and the user logged in again. The seven-day refresh window existed on paper
   * only.
   *
   * Rotation, not reuse: the row's token and refresh are both replaced. A leaked refresh
   * token is therefore good for exactly one exchange, and the legitimate holder's next
   * call fails loudly rather than both parties silently sharing a session.
   */
  redeemRefresh(refreshToken, context = {}) {
    if (!refreshToken) return { ok: false, code: 'E_NO_REFRESH' }
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE refresh_hash = ?')
      .get(hashToken(String(refreshToken)))
    if (!row) return { ok: false, code: 'E_NO_SESSION' }
    if (row.revoked_at !== null) return { ok: false, code: 'E_SESSION_REVOKED' }
    if (row.refresh_expires_at < Date.now()) return { ok: false, code: 'E_REFRESH_EXPIRED' }
    const user = this.findUserById(row.user_id)
    if (!user || user.status !== 'active') return { ok: false, code: 'E_USER_INACTIVE' }

    const token = newToken()
    const refresh = newToken()
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE sessions SET token_hash = ?, refresh_hash = ?, issued_at = ?, expires_at = ?,
                             refresh_expires_at = ?, ip = ?, user_agent = ?
         WHERE id = ?`,
      )
      .run(
        hashToken(token),
        hashToken(refresh),
        now,
        now + SESSION_TTL_MS,
        now + REFRESH_TTL_MS,
        context.ip ?? row.ip,
        context.userAgent ?? row.user_agent,
        row.id,
      )
    this.audit('session.refresh', { username: user.username }, user.username)
    return { ok: true, token, refresh, expiresIn: SESSION_TTL_MS / 1000, user }
  }

  // ------------------------------------------------------------ dsh bindings

  /** One row -> the shape the HTTP layer speaks. */
  bindingRow(row) {
    if (!row) return null
    return {
      dshUserId: row.dsh_user_id,
      marketUsername: row.market_username,
      dshName: row.dsh_name,
      deviceId: row.device_id ?? null,
      boundAt: row.bound_at,
      boundBy: row.bound_by,
    }
  }

  bindingForDsh(dshUserId) {
    if (!dshUserId) return null
    return this.bindingRow(this.db.prepare('SELECT * FROM dsh_bindings WHERE dsh_user_id = ?').get(dshUserId))
  }

  bindingForMarket(marketUsername) {
    if (!marketUsername) return null
    return this.bindingRow(this.db.prepare('SELECT * FROM dsh_bindings WHERE market_username = ?').get(marketUsername))
  }

  /**
   * Bindings for a page of users, so the accounts list can show each row's DSH account
   * without pulling the whole binding table.
   *
   * Filtering by username is what makes "show bindings inside the user row" affordable:
   * the alternative was a second unbounded list the console had to hold and join itself.
   * An empty `usernames` list means "no filter" and returns everything, which keeps the
   * existing whole-table callers working.
   */
  bindingsForMarketUsernames(usernames) {
    const wanted = Array.isArray(usernames) ? usernames.filter((name) => typeof name === 'string' && name !== '') : []
    if (wanted.length === 0) return this.listBindings()
    const marks = wanted.map(() => '?').join(', ')
    return this.db
      .prepare(`SELECT * FROM dsh_bindings WHERE market_username IN (${marks}) ORDER BY bound_at DESC`)
      .all(...wanted)
      .map((row) => this.bindingRow(row))
  }

  listBindings() {
    return this.db
      .prepare('SELECT * FROM dsh_bindings ORDER BY bound_at DESC')
      .all()
      .map((row) => this.bindingRow(row))
  }

  /**
   * Bind a DSH account to a market account, enforcing one-to-one in BOTH directions.
   *
   * The operator's rule is 「一个 DSH 账号只能绑一个市场账号」. Returning a distinct code
   * for each direction matters: "this DSH account is already bound" and "this market
   * account is already claimed" need different things done about them, and a generic
   * failure would leave the user unable to tell which side to unbind.
   *
   * Re-binding the SAME pair is a no-op success, so a page reload does not fail.
   */
  bindDshAccount({ dshUserId, marketUsername, dshName = '', deviceId = null, by = 'system', ip = null }) {
    const dshId = String(dshUserId ?? '').trim()
    const market = String(marketUsername ?? '').trim()
    if (!dshId) return { ok: false, code: 'E_BAD_DSH_ID' }
    if (!market) return { ok: false, code: 'E_BAD_MARKET_USER' }
    if (!this.findUser(market)) return { ok: false, code: 'E_NO_SUCH_USER' }

    const byDsh = this.bindingForDsh(dshId)
    const byMarket = this.bindingForMarket(market)

    /**
     * The binding secret.
     *
     * This is what makes auto-login possible WITHOUT treating the DSH account id as a
     * credential. Verified on this machine: `/dsh-market/identity` reflects any Origin, so
     * ANY website the user visits can read their DSH account id. If that id were enough to
     * obtain a session, every website could take over the bound market account.
     *
     * The secret is a real credential: random, stored only as a hash here, handed out
     * exactly once, and rotated on every (re)bind so an old one dies with its binding.
     */
    const secret = newToken()

    if (byDsh && byMarket && byDsh.dshUserId === byMarket.dshUserId) {
      // Already exactly this pair. Rotate the secret rather than leaving the old one live:
      // re-binding is an explicit act, and the caller is about to store the new value.
      this.db
        .prepare('UPDATE dsh_bindings SET dsh_name = ?, device_id = ?, secret_hash = ? WHERE dsh_user_id = ?')
        .run(String(dshName ?? ''), deviceId ?? null, hashToken(secret), dshId)
      return { ok: true, unchanged: true, secret, binding: this.bindingForDsh(dshId) }
    }
    if (byDsh) {
      return { ok: false, code: 'E_DSH_ALREADY_BOUND', detail: byDsh.marketUsername, binding: byDsh }
    }
    if (byMarket) {
      return { ok: false, code: 'E_MARKET_ALREADY_BOUND', detail: '该市场账号已绑定另一个 DSH 账号', binding: byMarket }
    }

    this.db
      .prepare(
        `INSERT INTO dsh_bindings (dsh_user_id, market_username, dsh_name, device_id, bound_at, bound_by, bound_ip, secret_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(dshId, market, String(dshName ?? ''), deviceId ?? null, Date.now(), by, ip, hashToken(secret))
    this.audit('dsh.bind', { dshUserId: dshId, marketUsername: market, by }, by)
    return { ok: true, secret, binding: this.bindingForDsh(dshId) }
  }

  /**
   * Exchange a binding secret for a session, the way a browser would after a login.
   *
   * Called by the DSH HOST PLUGIN, not by the page: the plugin holds the secret in the
   * profile, so it never reaches the browser. The DSH account id in the request is only a
   * lookup key — the secret is what is verified.
   */
  redeemBinding({ dshUserId, secret, ip = null, userAgent = null }) {
    const dshId = String(dshUserId ?? '').trim()
    if (!dshId || !secret) return { ok: false, code: 'E_BAD_REQUEST' }
    const row = this.db.prepare('SELECT * FROM dsh_bindings WHERE dsh_user_id = ?').get(dshId)
    if (!row) return { ok: false, code: 'E_NOT_BOUND' }
    if (!row.secret_hash) {
      // Bound before secrets existed: the user re-binds (or an admin does) to get one.
      return { ok: false, code: 'E_NO_SECRET', detail: '这条绑定没有密钥，需要重新绑定' }
    }
    if (row.secret_hash !== hashToken(String(secret))) {
      this.audit('dsh.redeem', { dshUserId: dshId, result: 'bad-secret' })
      return { ok: false, code: 'E_BAD_SECRET' }
    }
    const user = this.findUser(row.market_username)
    if (!user || user.status !== 'active') return { ok: false, code: 'E_USER_INACTIVE' }
    const issued = this.issueSession(user, { ip, userAgent })
    this.audit('dsh.redeem', { dshUserId: dshId, username: user.username, result: 'ok' }, user.username)
    return { ok: true, ...issued, user, refresh: issued.refresh }
  }

  /**
   * Unbind by EITHER side. Administration needs both directions: the DSH account may
   * be the thing that changed (a new machine, a reinstall) while the market account
   * stays, or the market account may be the thing being reassigned.
   */
  unbindDshAccount({ dshUserId = null, marketUsername = null, by = 'system' }) {
    const row = dshUserId
      ? this.db.prepare('SELECT * FROM dsh_bindings WHERE dsh_user_id = ?').get(dshUserId)
      : this.db.prepare('SELECT * FROM dsh_bindings WHERE market_username = ?').get(marketUsername)
    if (!row) return { ok: false, code: 'E_NOT_BOUND' }
    this.db.prepare('DELETE FROM dsh_bindings WHERE dsh_user_id = ?').run(row.dsh_user_id)
    this.audit('dsh.unbind', { dshUserId: row.dsh_user_id, marketUsername: row.market_username, by }, by)
    return { ok: true, binding: this.bindingRow(row) }
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Glob -> match: `*` any run, `?` one character. Mirrors policy.js by design. */
export function matches(pattern, name) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(name)
  } catch {
    return false
  }
}
