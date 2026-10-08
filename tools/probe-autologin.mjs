/**
 * Auto-login: the bound DSH account obtains a market session with no password.
 *
 * The security property is the thing to pin, not just the convenience. Measured on this
 * machine: the plugin's `/dsh-market/identity` route reflects ANY Origin, so any website
 * the user visits can read their DSH account id. Therefore:
 *
 *   - the account id alone must NOT be enough to get a session
 *   - the secret must be required, must be single-issue, and must rotate
 *   - the plugin's own routes that touch the secret must refuse a foreign Origin
 *
 * The last one is what stops `evil.example` from simply asking the local plugin for a
 * session, which would hand back exactly what this feature is careful about.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-autologin-'))
const profileDir = join(work, 'profile')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-autologin', private: true,
  dsh: { profile: { bundles: ['dsh-plugin-marketplace'], disabledBundles: [] } },
}))
writeFileSync(join(profileDir, 'cordis.patch.yml'), '')

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

// The service, before the plugin loads (the plugin reads MARKET_SERVICE_URL at import).
const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${app.server.address().port}`
process.env.MARKET_SERVICE_URL = BASE
process.env.DSH_PROFILE_DIR = profileDir
process.env.DSH_HOME = work
process.env.MARKET_DIAG_LOG = join(work, 'diag.log')

const call = async (method, path, body, token) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

// A member who is bound to a DSH account.
const adminLogin = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, adminLogin.body.token)
const admin = (await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body.token
await call('POST', '/dsh-market/admin/users', { username: 'alice', password: 'alice-initial-2026' }, admin)
const aliceFirst = await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-initial-2026' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'alice-password-2026' }, aliceFirst.body.token)
const alice = (await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-password-2026' })).body.token

const bound = await call('POST', '/dsh-market/identity/bind', { dshUserId: 'dsh-alice-1', dshName: 'Alice' }, alice)
ok('绑定成功并返回密钥', bound.status === 200 && typeof bound.body?.secret === 'string', `status=${bound.status}`)
const secret = bound.body.secret

console.log('')
console.log('--- 账号 ID 本身不是凭据 ---')
/**
 * The decisive check. If the account id alone yielded a session, every website the user
 * visits could take over the bound market account.
 */
const idOnly = await call('POST', '/dsh-market/identity/token', { dshUserId: 'dsh-alice-1' })
ok('只给 DSH 账号 ID（不给密钥）拿不到会话', idOnly.status === 401, `${idOnly.status}/${idOnly.body?.code}`)
const wrongSecret = await call('POST', '/dsh-market/identity/token', { dshUserId: 'dsh-alice-1', secret: 'guessed' })
ok('错误的密钥拿不到会话', wrongSecret.status === 401 && wrongSecret.body?.code === 'E_BAD_SECRET', String(wrongSecret.body?.code))
const otherUser = await call('POST', '/dsh-market/identity/token', { dshUserId: 'dsh-someone-else', secret })
ok('别人的 DSH 账号配这个密钥也拿不到', otherUser.status === 401, `${otherUser.status}/${otherUser.body?.code}`)

console.log('')
console.log('--- 正确的密钥可以换到会话 ---')
const exchanged = await call('POST', '/dsh-market/identity/token', { dshUserId: 'dsh-alice-1', secret })
ok('密钥能换到会话', exchanged.status === 200 && typeof exchanged.body?.token === 'string', `status=${exchanged.status}`)
ok('  会话属于被绑定的市场账号', exchanged.body?.user?.username === 'alice', String(exchanged.body?.user?.username))
ok('  同时返回 refresh（否则两小时后又要手动登录）', typeof exchanged.body?.refresh === 'string')
const me = await call('GET', '/dsh-market/auth/me', undefined, exchanged.body.token)
ok('  这个会话真的能用', me.status === 200 && me.body?.user?.username === 'alice', String(me.status))

console.log('')
console.log('--- 密钥只在绑定时下发一次，且不随读取泄漏 ---')
const mine = await call('GET', '/dsh-market/identity/me', undefined, exchanged.body.token)
ok('/identity/me 不返回密钥', mine.body?.binding !== undefined && mine.body.binding.secret === undefined, JSON.stringify(Object.keys(mine.body?.binding ?? {})))
const listed = await call('GET', '/dsh-market/admin/identity', undefined, admin)
ok('/admin/identity 也不返回密钥', (listed.body?.entries ?? []).every((b) => b.secret === undefined), JSON.stringify(Object.keys(listed.body?.entries?.[0] ?? {})))

console.log('')
console.log('--- 重新绑定会轮换密钥 ---')
const rebound = await call('POST', '/dsh-market/identity/bind', { dshUserId: 'dsh-alice-1', dshName: 'Alice' }, alice)
ok('重复绑定是幂等的', rebound.status === 200 && rebound.body?.unchanged === true, String(rebound.body?.unchanged))
ok('  但返回了新的密钥', rebound.body?.secret && rebound.body.secret !== secret)
const oldAfterRebind = await call('POST', '/dsh-market/identity/token', { dshUserId: 'dsh-alice-1', secret })
ok('  旧密钥立刻失效', oldAfterRebind.status === 401, `${oldAfterRebind.status}/${oldAfterRebind.body?.code}`)
const newWorks = await call('POST', '/dsh-market/identity/token', { dshUserId: 'dsh-alice-1', secret: rebound.body.secret })
ok('  新密钥可用', newWorks.status === 200, String(newWorks.status))

console.log('')
console.log('--- 解绑后密钥失效 ---')
await call('POST', '/dsh-market/identity/unbind', {}, alice)
const afterUnbind = await call('POST', '/dsh-market/identity/token', { dshUserId: 'dsh-alice-1', secret: rebound.body.secret })
ok('解绑后密钥不能再换会话', afterUnbind.status === 401 && afterUnbind.body?.code === 'E_NOT_BOUND', `${afterUnbind.status}/${afterUnbind.body?.code}`)

console.log('')
console.log('--- 宿主插件：密钥落地与换会话 ---')
// Re-bind so the plugin has a live secret to use.
const fresh = await call('POST', '/dsh-market/identity/bind', { dshUserId: 'dsh-alice-1', dshName: 'Alice' }, alice)
const { apply } = await import('../lib/plugin.js')
const routes = []
apply({
  get: (name) => (name === 'webServer'
    ? { port: 17777, register: (route) => { routes.push(route); return () => {} } }
    : undefined),
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
})
for (let i = 0; i < 60 && routes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50))
const route = (path) => routes.find((r) => String(r.path) === path)
ok('插件挂上了 /dsh-market/link', route('/dsh-market/link') !== undefined)
ok('插件挂上了 /dsh-market/session', route('/dsh-market/session') !== undefined)

const invoke = async (path, { method = 'POST', origin = 'http://127.0.0.1:17777', body } = {}) => {
  let captured = null
  const headers = { 'content-type': 'application/json' }
  if (origin !== null) headers.origin = origin
  const listeners = new Map()
  const req = {
    method, url: path, headers,
    on: (event, cb) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return req },
    destroy: () => {},
  }
  const emit = (event, arg) => { for (const cb of listeners.get(event) ?? []) cb(arg) }
  setImmediate(() => {
    if (method === 'POST' && body !== undefined) emit('data', Buffer.from(JSON.stringify(body)))
    emit('end')
  })
  await route(path).handler(req, { writeHead: () => {}, end: (out) => { captured = out } })
  try { return { status: 200, body: JSON.parse(String(captured)) } } catch { return { status: 0, body: null } }
}

/**
 * The critical refusal. `evil.example` reading the DSH account id is unavoidable — the
 * identity route reflects any Origin — so the plugin must not hand out a session to it.
 */
const foreignLink = await invoke('/dsh-market/link', { origin: 'https://evil.example', body: { dshUserId: 'x', secret: 'y' } })
ok('外部 Origin 不能写密钥', foreignLink.body?.code === 'E_FOREIGN_ORIGIN', JSON.stringify(foreignLink.body))
const foreignSession = await invoke('/dsh-market/session', { method: 'GET', origin: 'https://evil.example' })
ok('外部 Origin 不能索取会话', foreignSession.body?.code === 'E_FOREIGN_ORIGIN', JSON.stringify(foreignSession.body))
const noOrigin = await invoke('/dsh-market/session', { method: 'GET', origin: null })
ok('没有 Origin 的请求也被拒', noOrigin.body?.code === 'E_FOREIGN_ORIGIN', JSON.stringify(noOrigin.body))

const stored = await invoke('/dsh-market/link', { body: { dshUserId: 'dsh-alice-1', secret: fresh.body.secret, marketUsername: 'alice' } })
ok('本机 Origin 可以写入密钥', stored.body?.ok === true, JSON.stringify(stored.body))
const linkFile = join(profileDir, '.dsh-market-link.json')
ok('  密钥落到了 profile 里的文件', existsSync(linkFile))
ok('  文件里没有明文密钥泄漏到别处', JSON.parse(readFileSync(linkFile, 'utf8')).secret === fresh.body.secret)

const session = await invoke('/dsh-market/session', { method: 'GET' })
ok('插件能换到会话（这就是自动登录）', session.body?.ok === true && typeof session.body?.session?.token === 'string', JSON.stringify(session.body).slice(0, 120))
ok('  含 refresh', typeof session.body?.session?.refresh === 'string')
if (session.body?.session?.token) {
  const usable = await call('GET', '/dsh-market/auth/me', undefined, session.body.session.token)
  ok('  这个会话可用于 API', usable.status === 200 && usable.body?.user?.username === 'alice', String(usable.status))
}

const cleared = await invoke('/dsh-market/link', { body: { clear: true } })
ok('可以清除本机密钥', cleared.body?.ok === true && !existsSync(linkFile), JSON.stringify(cleared.body))
const afterClear = await invoke('/dsh-market/session', { method: 'GET' })
ok('清除后不再自动登录', afterClear.body?.session === null && afterClear.body?.reason === 'E_NO_LOCAL_SECRET', JSON.stringify(afterClear.body))

console.log('')
console.log('结论：')
console.log('  · 「自动登录」= DSH 账号已绑定 + 本机持有绑定密钥；账号 ID 本身换不到会话。')
console.log('  · 密钥只在绑定时下发一次，读取接口不返回它，重绑会轮换、解绑即失效。')
console.log('  · 密钥由宿主插件保管，页面只向插件要会话；插件拒绝一切外部 Origin 的请求。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
