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

    if (byDsh && byMarket && byDsh.dshUserId === byMarket.dshUserId) {
      // Already exactly this pair: refresh the display hint and report success.
      this.db
        .prepare('UPDATE dsh_bindings SET dsh_name = ?, device_id = ? WHERE dsh_user_id = ?')
        .run(String(dshName ?? ''), deviceId ?? null, dshId)
      return { ok: true, unchanged: true, binding: this.bindingForDsh(dshId) }
    }
    if (byDsh) {
      return { ok: false, code: 'E_DSH_ALREADY_BOUND', detail: byDsh.marketUsername, binding: byDsh }
    }
    if (byMarket) {
      return { ok: false, code: 'E_MARKET_ALREADY_BOUND', detail: '该市场账号已绑定另一个 DSH 账号', binding: byMarket }
    }

    this.db
      .prepare(
        `INSERT INTO dsh_bindings (dsh_user_id, market_username, dsh_name, device_id, bound_at, bound_by, bound_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(dshId, market, String(dshName ?? ''), deviceId ?? null, Date.now(), by, ip)
    this.audit('dsh.bind', { dshUserId: dshId, marketUsername: market, by }, by)
    return { ok: true, binding: this.bindingForDsh(dshId) }
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
