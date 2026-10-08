/**
 * Market server — HTTP surface.
 *
 * The DSH-side plugin is a client of this API and holds no authority: it asks
 * here for a catalog, for a verdict, and for bytes. Every read and every
 * mutation that concerns a plugin passes `policy.evaluate`, and every download is
 * re-hashed before it leaves.
 */
import { createServer } from 'node:http'
import { evaluate, statusFor } from './policy.js'
import { ArchiveError, inspectArchive, sha256 } from './pack.js'

const MAX_JSON_BYTES = 64 * 1024
/** Artifact uploads are binary and legitimately large; JSON stays tightly capped. */
const DEFAULT_MAX_UPLOAD_BYTES = Number(process.env.MARKET_MAX_UPLOAD_BYTES ?? 64 * 1024 * 1024)

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

  // -------------------------------------------------------------- device flow

  route('POST', '/dsh-market/auth/device/start', async (req, res) => {
    const body = await readBody(req)
    const started = store.startDeviceAuth(body?.deviceName ?? 'unknown device')
    json(res, 200, {
      ok: true,
      deviceCode: started.deviceCode,
      deviceSecret: started.deviceSecret,
      userCode: started.userCode,
      verificationUrl: `/market?activate=${started.userCode}`,
      expiresIn: started.expiresIn,
    })
  }, { auth: 'none' })

  route('POST', '/dsh-market/auth/device/poll', async (req, res) => {
    const body = await readBody(req)
    const state = store.pollDeviceAuth(body?.deviceCode)
    json(res, 200, { ok: true, status: state.status, deviceName: state.deviceName ?? null })
  }, { auth: 'none' })

  route('POST', '/dsh-market/auth/device/approve', async (req, res, caller) => {
    const body = await readBody(req)
    const result = store.approveDeviceAuth(String(body?.userCode ?? ''), caller.user)
    json(res, result.ok ? 200 : 400, result)
  })

  route('POST', '/dsh-market/auth/device/token', async (req, res) => {
    const body = await readBody(req)
    const result = store.redeemDeviceAuth(body?.deviceCode, body?.deviceSecret, clientInfo(req))
    if (!result.ok) {
      json(res, 400, { ok: false, code: result.code })
      return
    }
    json(res, 200, {
      ok: true,
      token: result.token,
      refresh: result.refresh,
      expiresIn: result.expiresIn,
      username: result.username,
    })
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

  route('GET', '/dsh-market/admin/users', (req, res) => {
    const who = admin(req, res)
    if (!who) return
    json(res, 200, {
      ok: true,
      users: store.listUsers().map((user) => ({
        ...publicUser(store, user),
        status: user.status,
        mustChangePassword: user.mustChangePassword,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      })),
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

  route('POST', '/dsh-market/admin/password', async (req, res) => {
    const who = admin(req, res)
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

  route('GET', '/dsh-market/admin/groups', (req, res) => {
    const who = admin(req, res)
    if (!who) return
    json(res, 200, { ok: true, groups: store.listGroups() })
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

  route('GET', '/dsh-market/admin/artifacts', (req, res) => {
    const who = admin(req, res)
    if (!who) return
    json(res, 200, {
      ok: true,
      artifacts: artifacts.catalogRows().map((artifact) => ({
        ...artifact,
        versions: artifacts.listVersions(artifact.name).map((item) => ({
          version: item.version,
          channel: item.channel,
          status: item.status,
        })),
      })),
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
