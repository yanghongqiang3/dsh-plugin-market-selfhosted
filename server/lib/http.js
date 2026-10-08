/**
 * Market server — HTTP surface.
 *
 * The DSH-side plugin is a client of this API and holds no authority: it asks
 * here for a catalog, for a verdict, and for bytes. Every read and every
 * mutation that concerns a plugin passes `policy.evaluate`, and every download is
 * re-hashed before it leaves.
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, statusFor } from './policy.js'
import { ArchiveError, inspectArchive, sha256 } from './pack.js'
import { paginate } from './store.js'

const MAX_JSON_BYTES = 64 * 1024
/** Artifact uploads are binary and legitimately large; JSON stays tightly capped. */
const DEFAULT_MAX_UPLOAD_BYTES = Number(process.env.MARKET_MAX_UPLOAD_BYTES ?? 64 * 1024 * 1024)

/**
 * Static files for the server console.
 *
 * The console is reached by URL and served by THIS service — deliberately not
 * embedded in DSH. Administration is a server-side job, so it does not need the
 * DSH shell, its host plugin, or a local profile. `market.css` and `shared.js` are
 * the very same files the DSH-hosted install page uses, so the two surfaces cannot
 * drift apart visually or in their auth plumbing.
 */
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')
const STATIC_FILES = new Map([
  ['/console', ['console.html', 'text/html; charset=utf-8']],
  ['/dsh-market/assets/market.css', ['market.css', 'text/css; charset=utf-8']],
  ['/dsh-market/assets/console.css', ['console.css', 'text/css; charset=utf-8']],
  ['/dsh-market/assets/shared.js', ['shared.js', 'text/javascript; charset=utf-8']],
])

export function createMarketServer({ store, artifacts, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES }) {
  const routes = []

  const route = (method, path, handler, options = {}) => {
    routes.push({
      method,
      path,
      handler,
      auth: options.auth ?? 'user',
      binary: options.binary === true,
      maxBytes: options.maxBytes ?? (options.binary === true ? maxUploadBytes : MAX_JSON_BYTES),
    })
  }

  // ------------------------------------------------------------------ helpers

  const json = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  /** Serve one of the console's static files, or 404 with a plain body. */
  const staticFile = (res, file, type) => {
    const full = join(WEB_DIR, file)
    if (!existsSync(full)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`missing asset: ${file}`)
      return
    }
    const bytes = readFileSync(full)
    res.writeHead(200, {
      'content-type': type,
      'content-length': bytes.length,
      'cache-control': 'no-store',
    })
    res.end(bytes)
  }

  /** Collect the request body as raw bytes, refusing anything over `limit`. */
  const readRawBody = (req, limit) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          const error = new Error('E_BODY_TOO_LARGE')
          error.limit = limit
          reject(error)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

  const readBody = async (req, limit = MAX_JSON_BYTES) => {
    const raw = await readRawBody(req, limit)
    const text = raw.toString('utf8')
    if (text === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('E_BAD_JSON')
    }
  }

  const tokenOf = (req) => {
    const header = req.headers.authorization
    if (typeof header !== 'string') return null
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    return match ? match[1] : null
  }

  const uri = (res, code, detail) => {
    const status = code === 'E_BAD_JSON' || code === 'E_BODY_TOO_LARGE' ? 400 : 500
    json(res, status, { ok: false, code, detail: detail ?? null })
  }

  const publicUser = (store_, user) => ({
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    groups: store_.groupsOf(user.username).map((group) => group.id),
  })

  const clientInfo = (req) => ({
    ip: req.socket?.remoteAddress ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  })

  /** Catalog entries the caller may act on, each annotated with why or why not. */
  const annotatedCatalog = (caller) =>
    artifacts.catalogRows().map((artifact) => {
      const verdict = evaluate(store, caller, artifact)
      return {
        name: artifact.name,
        version: artifact.version,
        channel: artifact.channel,
        status: artifact.status,
        owner: artifact.owner,
        summary: artifact.summary,
        dsh: artifact.dsh,
        permissions: artifact.permissions,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        publishedAt: artifact.publishedAt,
        canInstall: verdict.allowed,
        reason: verdict.code ?? null,
      }
    })

  // --------------------------------------------------------------------- auth

  route('POST', '/dsh-market/auth/login', async (req, res) => {
    const body = await readBody(req)
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!username || !password) {
      json(res, 400, { ok: false, code: 'E_BAD_REQUEST', detail: '需要 username 与 password' })
      return
    }
    const result = store.authenticate(username, password)
    if (!result.ok) {
      const status = result.code === 'E_LOCKED' ? 423 : 401
      json(res, status, { ok: false, code: result.code, detail: result.code === 'E_LOCKED' ? '账号已锁定，请稍后或联系管理员' : '用户名或密码错误' })
      return
    }
    const issued = store.issueSession(result.user, clientInfo(req))
    json(res, 200, {
      ok: true,
      token: issued.token,
      refresh: issued.refresh,
      expiresIn: issued.expiresIn,
      mustChangePassword: result.user.mustChangePassword,
      user: publicUser(store, result.user),
      role: result.user.role,
    })
  }, { auth: 'none' })

  route('POST', '/dsh-market/auth/logout', (req, res) => {
    const token = tokenOf(req)
    json(res, 200, { ok: true, revoked: token ? store.revokeSession(token) : false })
  }, { auth: 'none' })

  route('GET', '/dsh-market/auth/me', (req, res, caller) => {
    json(res, 200, {
      ok: true,
      user: publicUser(store, caller.user),
      role: caller.user.role,
      mustChangePassword: caller.mustChangePassword,
      groups: store.groupsOf(caller.user.username).map((group) => group.id),
      service: { name: 'dsh-plugin-marketplace-service', version: 1 },
    })
  })

  // Not behind the password gate: this is the one route a first-login user must reach.
  /**
   * Exchange a refresh token for a new session.
   *
   * `auth: 'none'` because the refresh token IS the credential here — requiring a valid
   * session would defeat the point, since the session is exactly what has expired.
   */
  route('POST', '/dsh-market/auth/refresh', async (req, res) => {
    const body = await readBody(req)
    const result = store.redeemRefresh(body?.refresh, clientInfo(req))
    if (!result.ok) {
      json(res, 401, { ok: false, code: result.code, detail: '刷新令牌无效或已过期，请重新登录' })
      return
    }
    json(res, 200, {
      ok: true,
      token: result.token,
      refresh: result.refresh,
      expiresIn: result.expiresIn,
      user: publicUser(store, result.user),
    })
  }, { auth: 'none' })

  route('POST', '/dsh-market/auth/password', async (req, res) => {
    const caller = store.resolveSession(tokenOf(req))
    if (!caller) {
      json(res, 401, { ok: false, code: 'E_NOT_LOGGED_IN' })
      return
    }
    const body = await readBody(req)
    const next = typeof body?.newPassword === 'string' ? body.newPassword : ''
    if (next.length < 12) {
      json(res, 400, { ok: false, code: 'E_WEAK_PASSWORD', detail: '新密码至少 12 位' })
      return
    }
    store.setPassword(caller.user.username, next, { mustChange: false, by: caller.user.username })
    json(res, 200, { ok: true })
  }, { auth: 'none' })

  // -------------------------------------------------------------- marketplace

  route('GET', '/dsh-market/catalog', (req, res, caller) => {
    json(res, 200, {
      ok: true,
      service: 'remote',
      user: publicUser(store, caller.user),
      groups: store.groupsOf(caller.user.username).map((group) => group.id),
      entries: annotatedCatalog(caller),
    })
  })

  route('GET', '/dsh-market/detail', (req, res, caller, url) => {
    const name = url.searchParams.get('name')
    const version = url.searchParams.get('version')
    const artifact = version ? artifacts.get(name, version) : artifacts.latest(name)
    if (!artifact) {
      json(res, 404, { ok: false, code: 'E_NOT_FOUND' })
      return
    }
    const verdict = evaluate(store, caller, artifact)
    if (!verdict.allowed) {
      json(res, statusFor(verdict.code), { ok: false, code: verdict.code, detail: verdict.detail ?? null })
      return
    }
    json(res, 200, {
      ...artifact,
      canInstall: true,
      reason: null,
      versions: artifacts.listVersions(name).map((item) => ({
        version: item.version,
        channel: item.channel,
        status: item.status,
        sha256: item.sha256,
      })),
    })
  })

  /**
   * Hand back the archive only after re-checking authorization AND re-hashing the
   * stored bytes. The response carries the hash the installer must verify.
   */
  route('GET', '/dsh-market/download', (req, res, caller, url) => {
    const name = url.searchParams.get('name')
    const version = url.searchParams.get('version')
    const channel = url.searchParams.get('channel') ?? undefined
    const artifact = version
      ? artifacts.get(name, version, channel ?? 'stable')
      : artifacts.latest(name, channel)
    if (!artifact) {
      json(res, 404, { ok: false, code: 'E_NOT_FOUND' })
      return
    }
    const verdict = evaluate(store, caller, artifact)
    if (!verdict.allowed) {
      store.audit('deny', { action: 'download', name, version, code: verdict.code }, caller.user.username)
      json(res, statusFor(verdict.code), { ok: false, code: verdict.code, detail: verdict.detail ?? null })
      return
    }
    const verified = artifacts.readVerified(artifact)
    if (!verified.ok) {
      json(res, 500, { ok: false, code: verified.code, detail: '服务端制品与登记的哈希不一致，已阻止下载' })
      return
    }
    store.audit('download', { name: artifact.name, version: artifact.version }, caller.user.username)
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': verified.bytes.length,
      'x-artifact-name': artifact.name,
      'x-artifact-version': artifact.version,
      'x-artifact-channel': artifact.channel,
      'x-artifact-sha256': artifact.sha256,
      'x-artifact-kind': 'tgz',
      'cache-control': 'no-store',
    })
    res.end(verified.bytes)
  })

  /**
   * Authorization decision for one (name, version) without moving bytes.
   * The local plugin calls this before writing anything into a profile.
   */
  route('POST', '/dsh-market/authorize', async (req, res, caller) => {
    const body = await readBody(req)
    const artifact = body?.version
      ? artifacts.get(body?.name, body.version, body?.channel ?? 'stable')
      : artifacts.latest(body?.name, body?.channel ?? null)
    if (!artifact) {
      json(res, 404, { ok: false, code: 'E_NOT_FOUND' })
      return
    }
    const verdict = evaluate(store, caller, artifact)
    if (!verdict.allowed) {
      store.audit('deny', { action: 'authorize', name: body?.name, code: verdict.code }, caller.user.username)
      json(res, statusFor(verdict.code), { ok: false, code: verdict.code, detail: verdict.detail ?? null })
      return
    }
    json(res, 200, { ok: true, artifact: { ...artifact, canInstall: true } })
  })

  // -------------------------------------------------------------------- admin

  const admin = (req, res) => {
    const caller = store.resolveSession(tokenOf(req))
    if (!caller) {
      json(res, 401, { ok: false, code: 'E_NOT_LOGGED_IN' })
      return null
    }
    if (caller.mustChangePassword) {
      json(res, 403, { ok: false, code: 'E_MUST_CHANGE_PASSWORD' })
      return null
    }
    if (caller.user.role !== 'admin') {
      store.audit('deny', { action: 'admin', code: 'E_NOT_ADMIN' }, caller.user.username)
      json(res, 403, { ok: false, code: 'E_NOT_ADMIN', detail: '需要管理员权限' })
      return null
    }
    return caller.user
  }

  /**
   * Paged admin lists all speak the same query and the same response.
   *
   * `limit`/`offset`/`q` are read in one place so every list clamps identically and an
   * out-of-range offset yields an empty page rather than an error — the console may ask
   * for page 9 of a list that shrank to 2 pages while it was open.
   *
   * BOTH shapes are returned: `entries`/`total`/`limit`/`offset` (what the console uses)
   * and the historical field name (`users`, `groups`, …) holding the page. The service is
   * consumed by the CLI, the console and tests; changing the shape without leaving the old
   * key in place would break callers that only wanted the list, for no benefit. The
   * duplicated payload is one page, not the whole table.
   */
  const pageParams = (url) => ({
    limit: url?.searchParams?.get('limit') ?? undefined,
    offset: url?.searchParams?.get('offset') ?? undefined,
    q: url?.searchParams?.get('q') ?? '',
  })

  route('GET', '/dsh-market/admin/users', (req, res, _caller, url) => {
    const who = admin(req, res)
    if (!who) return
    const page = store.listUsersPage(pageParams(url))
    json(res, 200, {
      ok: true,
      entries: page.entries.map((user) => ({
        ...publicUser(store, user),
        status: user.status,
        mustChangePassword: user.mustChangePassword,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      })),
      users: page.entries.map((user) => ({
        ...publicUser(store, user),
        status: user.status,
        mustChangePassword: user.mustChangePassword,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      audit: store.recentAudit(50),
    })
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/users', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    try {
      const created = store.createUser({
        username: String(body?.username ?? '').trim(),
        password: String(body?.password ?? ''),
        displayName: body?.displayName,
        role: body?.role,
        mustChangePassword: body?.mustChangePassword !== false,
        createdBy: who.username,
      })
      if (Array.isArray(body?.groups)) {
        for (const groupId of body.groups) store.setMembership(created.username, String(groupId), true, { by: who.username })
      }
      json(res, 200, { ok: true, user: publicUser(store, store.findUser(created.username)) })
    } catch (error) {
      json(res, 400, { ok: false, code: 'E_CREATE_FAILED', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/password', async (req, res) => {    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    try {
      store.setPassword(String(body?.username ?? ''), String(body?.password ?? ''), {
        mustChange: body?.mustChange !== false,
        by: who.username,
      })
      json(res, 200, { ok: true })
    } catch (error) {
      json(res, 400, { ok: false, code: 'E_RESET_FAILED', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/status', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    try {
      const updated = store.setStatus(
        String(body?.username ?? ''),
        body?.status === 'disabled' ? 'disabled' : 'active',
        { by: who.username, reason: body?.reason },
      )
      json(res, 200, { ok: true, status: updated.status, revokedSessions: updated.revokedSessions })
    } catch (error) {
      json(res, 400, { ok: false, code: 'E_STATUS_FAILED', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/role', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    try {
      const updated = store.setRole(String(body?.username ?? ''), body?.role, { by: who.username })
      json(res, 200, { ok: true, role: updated.role })
    } catch (error) {
      json(res, 400, { ok: false, code: 'E_ROLE_FAILED', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  /**
   * Change a display name.
   *
   * Its own route rather than part of a general "update user" call: every other field of
   * an account is either an identity (username, immutable), an authorisation (role,
   * status) or a credential (password) — each with its own audit action and consequence.
   * A display name is purely presentational, and giving it the same shape as the rest is
   * what keeps the audit log readable.
   */
  route('POST', '/dsh-market/admin/displayName', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    try {
      const updated = store.setDisplayName(
        String(body?.username ?? ''),
        String(body?.displayName ?? ''),
        { by: who.username },
      )
      json(res, 200, { ok: true, displayName: updated.displayName ?? '' })
    } catch (error) {
      json(res, 400, { ok: false, code: 'E_DISPLAY_NAME_FAILED', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  route('GET', '/dsh-market/admin/groups', (req, res, _caller, url) => {
    const who = admin(req, res)
    if (!who) return
    const page = store.listGroupsPage(pageParams(url))
    json(res, 200, {
      ok: true,
      entries: page.entries,
      groups: page.entries,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    })
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/groups', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    try {
      store.createGroup({
        id: String(body?.id ?? '').trim(),
        name: body?.name,
        description: body?.description,
        by: who.username,
      })
      json(res, 200, { ok: true, groups: store.listGroups() })
    } catch (error) {
      json(res, 400, { ok: false, code: 'E_GROUP_FAILED', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  /**
   * Edit or delete an existing group.
   *
   * Only the description is editable: the ID is what grants and memberships reference,
   * and letting it change would silently repoint every stored rule. Deleting removes the
   * memberships and grants with it — leaving them behind would keep an install permission
   * alive that no administrator can see, because the group it belonged to is gone.
   */
  route('POST', '/dsh-market/admin/groups/update', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    const id = String(body?.id ?? '').trim()
    if (!id) {
      json(res, 400, { ok: false, code: 'E_BAD_REQUEST', detail: '需要 id' })
      return
    }
    try {
      const group = store.updateGroup(id, {
        description: String(body?.description ?? ''),
        by: who.username,
      })
      json(res, 200, { ok: true, group })
    } catch (error) {
      json(res, 404, { ok: false, code: 'E_NO_SUCH_GROUP', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/groups/delete', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    const id = String(body?.id ?? '').trim()
    if (!id) {
      json(res, 400, { ok: false, code: 'E_BAD_REQUEST', detail: '需要 id' })
      return
    }
    try {
      const removed = store.deleteGroup(id, { by: who.username })
      json(res, 200, { ok: true, ...removed })
    } catch (error) {
      json(res, 404, { ok: false, code: 'E_NO_SUCH_GROUP', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/membership', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    try {
      const groups = store.setMembership(
        String(body?.username ?? ''),
        String(body?.groupId ?? ''),
        body?.on !== false,
        { by: who.username },
      )
      json(res, 200, { ok: true, groups })
    } catch (error) {
      json(res, 400, { ok: false, code: 'E_MEMBERSHIP_FAILED', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  /**
   * Every rule, flat and paged.
   *
   * Until now the console assembled this from each group's nested `grants`, which is why
   * the rules table could not be paged or searched on its own. A flat list is also the
   * honest shape: a rule belongs to a group, but it is still a row an administrator wants
   * to sort and edit directly.
   */
  route('GET', '/dsh-market/admin/grants', (req, res, _caller, url) => {
    const who = admin(req, res)
    if (!who) return
    const page = store.listGrantsPage(pageParams(url))
    json(res, 200, {
      ok: true,
      entries: page.entries,
      grants: page.entries,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    })
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/grants/update', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    try {
      const grant = store.updateGrant({
        groupId: String(body?.groupId ?? ''),
        pluginPattern: String(body?.pluginPattern ?? ''),
        nextPattern: body?.nextPattern === undefined ? null : String(body.nextPattern),
        effect: body?.effect,
        channel: body?.channel ?? null,
        by: who.username,
      })
      json(res, 200, { ok: true, grant })
    } catch (error) {
      json(res, 404, { ok: false, code: 'E_NO_SUCH_GRANT', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/grants', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    try {
      const groupId = String(body?.groupId ?? '')
      const pluginPattern = String(body?.pluginPattern ?? '')
      if (!groupId || !pluginPattern) {
        json(res, 400, { ok: false, code: 'E_BAD_REQUEST', detail: '需要 groupId 与 pluginPattern' })
        return
      }
      if (body?.remove === true) store.removeGrant({ groupId, pluginPattern, by: who.username })
      else
        store.addGrant({
          groupId,
          pluginPattern,
          effect: body?.effect,
          channel: body?.channel ?? null,
          by: who.username,
        })
      json(res, 200, { ok: true, groups: store.listGroups() })
    } catch (error) {
      json(res, 400, { ok: false, code: 'E_GRANT_FAILED', detail: String(error?.message ?? error) })
    }
  }, { auth: 'none' })

  // ------------------------------------------------------------------ publish

  /**
   * Upload a packed artifact.
   *
   * Default is a DRY RUN: the archive is inspected and its metadata reported, but
   * nothing is written. `?commit=1` performs the publish. This lets a CI job or a
   * person validate a build without touching the live catalog.
   *
   * The archive is inspected before it reaches storage, so a malformed or
   * path-escaping upload is refused with a reason instead of half-written.
   */
  route(
    'POST',
    '/dsh-market/publish',
    async (req, res, _caller, url) => {
      const who = admin(req, res)
      if (!who) return

      const archive = await readRawBody(req, maxUploadBytes)
      if (archive.length === 0) {
        json(res, 400, { ok: false, code: 'E_EMPTY_BODY', detail: '请求体为空，需要上传 .tar.gz' })
        return
      }

      const commit = url.searchParams.get('commit') === '1'
      const state = url.searchParams.get('state') ?? undefined
      const channel = url.searchParams.get('channel') ?? undefined

      // Always inspect first — this is what makes dry run and commit share a path.
      let inspection
      try {
        inspection = inspectArchive(archive)
      } catch (error) {
        store.audit('artifact.reject', { reason: String(error?.message ?? error), by: who.username }, who.username)
        json(res, 400, {
          ok: false,
          code: error instanceof ArchiveError ? 'E_BAD_ARCHIVE' : 'E_INSPECT_FAILED',
          detail: String(error?.message ?? error),
        })
        return
      }
      if (!inspection.ok) {
        store.audit('artifact.reject', { code: inspection.code, by: who.username }, who.username)
        json(res, 400, { ok: false, code: inspection.code, detail: inspection.detail })
        return
      }

      const preview = {
        name: inspection.pkg.name,
        version: inspection.pkg.version,
        channel: channel ?? inspection.meta.channel ?? 'stable',
        state: state ?? inspection.meta.state ?? 'published',
        owner: inspection.meta.owner ?? inspection.pkg.dsh?.market?.owner ?? '',
        summary: inspection.meta.summary ?? inspection.pkg.description ?? '',
        files: inspection.files.length,
        sizeBytes: archive.length,
        sha256: sha256(archive),
      }

      if (!commit) {
        json(res, 200, { ok: true, dryRun: true, wouldPublish: preview })
        return
      }

      try {
        const artifact = artifacts.publishArchive(archive, {
          publishedBy: who.username,
          state,
          channel,
        })
        json(res, 200, { ok: true, dryRun: false, artifact })
      } catch (error) {
        json(res, 400, {
          ok: false,
          code: error?.code ?? 'E_PUBLISH_FAILED',
          detail: String(error?.message ?? error),
        })
      }
    },
    { auth: 'none', binary: true },
  )

  route('POST', '/dsh-market/admin/artifacts/state', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    const name = String(body?.name ?? '')
    const version = String(body?.version ?? '')
    const channel = String(body?.channel ?? 'stable')
    const state = String(body?.state ?? '')
    const changed = artifacts.setState(name, version, channel, state)
    store.audit('artifact.state', { name, version, channel, state, changed }, who.username)
    json(res, changed ? 200 : 404, { ok: changed, code: changed ? null : 'E_NOT_FOUND', state })
  }, { auth: 'none' })

  route('GET', '/dsh-market/admin/artifacts', (req, res, _caller, url) => {
    const who = admin(req, res)
    if (!who) return
    const params = pageParams(url)
    const decorated = artifacts.catalogRows().map((artifact) => ({
      ...artifact,
      versions: artifacts.listVersions(artifact.name).map((item) => ({
        version: item.version,
        channel: item.channel,
        status: item.status,
      })),
    }))
    const needle = String(params.q ?? '').trim().toLowerCase()
    const filtered = needle === ''
      ? decorated
      : decorated.filter((artifact) =>
        [artifact.name, artifact.version, artifact.channel, artifact.state, artifact.owner ?? '']
          .some((field) => String(field ?? '').toLowerCase().includes(needle)))
    // Same `paginate` helper the store uses, so clamping and the response shape cannot
    // drift between a paged list that lives in the store and one that lives here.
    const page = paginate(filtered, params.limit, params.offset)
    json(res, 200, {
      ok: true,
      entries: page.entries,
      artifacts: page.entries,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    })
  }, { auth: 'none' })


  route('GET', '/dsh-market/health', (req, res) => {
    json(res, 200, {
      ok: true,
      service: 'dsh-plugin-marketplace-service',
      users: store.countUsers(),
      artifacts: artifacts.catalogRows().length,
      time: Date.now(),
    })
  }, { auth: 'none' })

  // ------------------------------------------------------- the plugin's own copy
  //
  // The client plugin auto-updates from HERE rather than from the market catalog.
  //
  // Two reasons. First, the market's artifact format is flat while an installable npm
  // tarball must keep everything under `package/` — the market cannot distribute this
  // plugin through the same path it distributes others (§7 of docs/distributing.md).
  // Second, the service and the plugin are deployed together: whoever updates the
  // service has the new package in hand, so the service is the natural place to carry it
  // and no separate distribution channel has to be maintained.
  //
  // Distinct paths from /catalog on purpose, so a client cannot confuse the plugin it
  // runs with a plugin it may install.

  /** What package this service carries, so a client can decide whether to update. */
  route('GET', '/dsh-market/self', (req, res) => {
    const held = artifacts.marketplacePackage()
    if (held === null) {
      // Not an error: a service with no package staged simply cannot offer one, and the
      // client must be able to tell that apart from a failure.
      json(res, 200, { ok: true, available: false })
      return
    }
    json(res, 200, {
      ok: true,
      available: true,
      name: held.name,
      version: held.version,
      sha256: held.sha256,
      sizeBytes: held.sizeBytes,
      publishedAt: held.publishedAt,
    })
  }, { auth: 'none' })

  /** The bytes. Unauthenticated for the same reason `/self` is: it is not market data. */
  route('GET', '/dsh-market/self/download', (req, res) => {
    const bytes = artifacts.marketplaceBytes()
    if (bytes === null) {
      json(res, 404, { ok: false, code: 'E_NO_SELF_PACKAGE' })
      return
    }
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': bytes.length,
      'x-artifact-sha256': sha256(bytes),
      'cache-control': 'no-store',
    })
    res.end(bytes)
  }, { auth: 'none' })

  // ------------------------------------------------------------ console pages
  //
  // Served here, not through DSH: administration must be reachable with a browser
  // and a URL, independent of any DSH install, and it is not something a plugin
  // client should be able to reach into. The DSH page is the install catalog only.

  route('GET', '/', (req, res) => {
    json(res, 200, {
      ok: true,
      service: 'dsh-plugin-marketplace-service',
      console: '/console',
      entry: '在 DSH 内点击左侧栏底部的「内部插件市场」安装与卸载插件；账号、权限、发布在本控制台。',
    })
  }, { auth: 'none' })

  for (const [path, [file, type]] of STATIC_FILES) {
    route('GET', path, (_req, res) => staticFile(res, file, type), { auth: 'none' })
  }

  // ------------------------------------------------------------ dsh bindings
  //
  // Tying a DSH account to a market account, so a user does not have to log in a
  // second time inside the DSH page. The DSH account id comes from the HOST PLUGIN,
  // which reads it from the composed account service; the market account comes from
  // the caller's bearer token. Those two facts are combined HERE and nowhere else,
  // which is what stops a caller from claiming someone else's DSH identity.
  //
  // The operator's rule is one-to-one (「一个 DSH 账号只能绑一个市场账号」); the store
  // enforces both directions and reports which side collided.

  route('GET', '/dsh-market/identity/lookup', (req, res, _caller, url) => {
    const dshUserId = String(url.searchParams.get('dshUserId') ?? '').trim()
    if (!dshUserId) {
      json(res, 400, { ok: false, code: 'E_BAD_DSH_ID' })
      return
    }
    const binding = store.bindingForDsh(dshUserId)
    // Reports only WHETHER the account is bound, never to whom: an unauthenticated
    // caller must not be able to enumerate other people's accounts.
    json(res, 200, { ok: true, bound: binding !== null })
  }, { auth: 'none' })

  /**
   * Exchange a BINDING SECRET for a session — the auto-login path.
   *
   * Called by the DSH host plugin, which holds the secret in the profile and never hands
   * it to the browser. `auth: 'none'` because the secret IS the credential.
   *
   * Deliberately NOT "log in with a DSH account id". The id is not a secret: the plugin's
   * `/dsh-market/identity` route reflects any Origin, so any website the user visits can
   * read it. Making it sufficient for a session would let any website take over the bound
   * market account. The id here is only a lookup key; the secret is verified.
   */
  route('POST', '/dsh-market/identity/token', async (req, res) => {
    const body = await readBody(req)
    const result = store.redeemBinding({
      dshUserId: body?.dshUserId,
      secret: body?.secret,
      ...clientInfo(req),
    })
    if (!result.ok) {
      json(res, 401, { ok: false, code: result.code, detail: result.detail ?? '绑定密钥无效' })
      return
    }
    json(res, 200, {
      ok: true,
      token: result.token,
      refresh: result.refresh,
      expiresIn: result.expiresIn,
      user: publicUser(store, result.user),
    })
  }, { auth: 'none' })

  route('POST', '/dsh-market/identity/bind', async (req, res, caller) => {
    const body = await readBody(req)
    const result = store.bindDshAccount({
      dshUserId: body?.dshUserId,
      marketUsername: caller.user.username,
      dshName: body?.dshName ?? '',
      deviceId: body?.deviceId ?? null,
      by: caller.user.username,
      ip: clientInfo(req).ip,
    })
    if (!result.ok) {
      const status = result.code === 'E_NO_SUCH_USER' || result.code === 'E_BAD_DSH_ID' ? 400 : 409
      json(res, status, { ok: false, code: result.code, detail: result.detail ?? null })
      return
    }
    /**
     * The binding secret is returned HERE and only here — this is the one moment it
     * exists in plaintext. The page hands it straight to the DSH host plugin, which keeps
     * it in the profile; the service keeps only its hash.
     *
     * `bindingRow` deliberately does NOT carry it, so no read route can leak it.
     */
    json(res, 200, {
      ok: true,
      unchanged: result.unchanged === true,
      binding: result.binding,
      secret: result.secret,
    })
  })

  route('GET', '/dsh-market/identity/me', (req, res, caller) => {
    json(res, 200, { ok: true, binding: store.bindingForMarket(caller.user.username) })
  })

  /**
   * Release YOUR OWN binding.
   *
   * Deliberately not an administrator action. The binding is the user's own account
   * link, and requiring an administrator to undo it means a mistyped sign-in becomes
   * a support ticket. It takes no identifier at all — the binding released is the one
   * belonging to the caller's token, so there is nothing to forge and no way to touch
   * anyone else's.
   *
   * The administrative route below still exists for the case the user cannot act on:
   * a DSH account whose owner is gone, or a market account being reassigned.
   */
  route('POST', '/dsh-market/identity/unbind', (req, res, caller) => {
    const current = store.bindingForMarket(caller.user.username)
    if (current === null) {
      json(res, 404, { ok: false, code: 'E_NOT_BOUND' })
      return
    }
    const result = store.unbindDshAccount({ dshUserId: current.dshUserId, by: caller.user.username })
    if (!result.ok) {
      json(res, 404, { ok: false, code: result.code })
      return
    }
    json(res, 200, { ok: true, binding: result.binding })
  })

  /**
   * Every binding, for the console.
   *
   * Being able to SEE who holds a slot is what makes the one-to-one rule workable:
   * a conflict message names the other side, and an administrator has to be able to
   * look up which account that is before releasing anything.
   */
  route('GET', '/dsh-market/admin/identity', (req, res, _caller, url) => {
    const who = admin(req, res)
    if (!who) return
    // `?usernames=a,b` narrows the answer to the accounts currently on screen, which is
    // what lets the accounts table show each row's DSH binding without pulling the whole
    // binding table. No filter means everything, so existing callers are unaffected.
    const raw = url?.searchParams?.get('usernames') ?? ''
    const usernames = raw === '' ? [] : raw.split(',').map((name) => name.trim()).filter(Boolean)
    const rows = store.bindingsForMarketUsernames(usernames)
    json(res, 200, { ok: true, bindings: rows, entries: rows, total: rows.length })
  }, { auth: 'none' })

  route('POST', '/dsh-market/admin/identity/unbind', async (req, res) => {
    const who = admin(req, res)
    if (!who) return
    const body = await readBody(req)
    const result = store.unbindDshAccount({
      dshUserId: body?.dshUserId ?? null,
      marketUsername: body?.marketUsername ?? null,
      by: who.username,
    })
    if (!result.ok) {
      json(res, 404, { ok: false, code: result.code })
      return
    }
    json(res, 200, { ok: true, binding: result.binding })
  }, { auth: 'none' })

  // ----------------------------------------------------------------- dispatch

  const server = createServer(async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      uri(res, 'E_BAD_REQUEST', 'bad url')
      return
    }

    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const match = routes.find((item) => item.method === req.method && item.path === url.pathname)
    if (!match) {
      json(res, 404, { ok: false, code: 'E_NO_ROUTE', detail: url.pathname })
      return
    }

    try {
      if (match.auth === 'user') {
        const caller = store.resolveSession(tokenOf(req))
        if (!caller) {
          json(res, 401, { ok: false, code: 'E_NOT_LOGGED_IN' })
          return
        }
        if (caller.mustChangePassword) {
          json(res, 403, { ok: false, code: 'E_MUST_CHANGE_PASSWORD', detail: '请先修改初始密码' })
          return
        }
        await match.handler(req, res, caller, url)
        return
      }
      await match.handler(req, res, null, url)
    } catch (error) {
      const code = String(error?.message ?? error)
      if (code === 'E_BODY_TOO_LARGE') {
        json(res, 413, {
          ok: false,
          code,
          detail: `请求体过大（上限 ${Math.round(match.maxBytes / 1024 / 1024)} MB）`,
        })
        return
      }
      if (code === 'E_BAD_JSON') {
        json(res, 400, { ok: false, code, detail: '请求体不是有效 JSON' })
        return
      }
      store.audit('error', { path: url.pathname, message: String(error?.stack ?? error) })
      json(res, 500, { ok: false, code: 'E_INTERNAL', detail: String(error?.message ?? error) })
    }
  })

  return { server, routes }
}
