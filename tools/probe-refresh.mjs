/**
 * The refresh token: issued, redeemable, rotating, and revocable.
 *
 * It was issued and stored from the first day but nothing ever redeemed it, so a session
 * died after two hours and the user signed in again. These checks pin the properties that
 * make redeeming it safe, not merely possible.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-refresh-'))
const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${app.server.address().port}`

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}
const call = async (method, path, body, token) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const login = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })
ok('登录返回 refresh 令牌', typeof login.body?.refresh === 'string' && login.body.refresh.length > 20)
await call('POST', '/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, login.body.token)
const session = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })
const first = { token: session.body.token, refresh: session.body.refresh }

const before = await call('GET', '/dsh-market/auth/me', undefined, first.token)
ok('原会话可用', before.status === 200, String(before.status))

const renewed = await call('POST', '/dsh-market/auth/refresh', { refresh: first.refresh })
ok('refresh 能换到新会话', renewed.status === 200 && typeof renewed.body?.token === 'string', `status=${renewed.status}`)
ok('refresh 返回新的 refresh（轮换）', renewed.body?.refresh && renewed.body.refresh !== first.refresh)
ok('refresh 返回用户信息', renewed.body?.user?.username === 'admin', JSON.stringify(renewed.body?.user?.username))

const afterNew = await call('GET', '/dsh-market/auth/me', undefined, renewed.body.token)
ok('新会话可用', afterNew.status === 200, String(afterNew.status))
const afterOld = await call('GET', '/dsh-market/auth/me', undefined, first.token)
ok('旧会话令牌已被顶掉（轮换而非并存）', afterOld.status === 401, String(afterOld.status))

/**
 * The old refresh token must be dead. If both stayed valid, a leaked refresh token would
 * keep working alongside the legitimate one and rotation would buy nothing.
 */
const replay = await call('POST', '/dsh-market/auth/refresh', { refresh: first.refresh })
ok('旧 refresh 已失效（不能重放）', replay.status === 401, `${replay.status}/${replay.body?.code}`)
ok('  错误码说明了原因', replay.body?.code === 'E_NO_SESSION', String(replay.body?.code))

const junk = await call('POST', '/dsh-market/auth/refresh', { refresh: 'not-a-real-token' })
ok('伪造的 refresh 被拒', junk.status === 401, String(junk.status))
const missing = await call('POST', '/dsh-market/auth/refresh', {})
ok('缺少 refresh 被拒', missing.status === 401 && missing.body?.code === 'E_NO_REFRESH', String(missing.body?.code))

/**
 * Logout must revoke the refresh too, or the next request would silently sign the user
 * back in — a logout that does not log out.
 */
const second = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })
await call('POST', '/dsh-market/auth/logout', {}, second.body.token)
const afterLogout = await call('POST', '/dsh-market/auth/refresh', { refresh: second.body.refresh })
ok('登出后 refresh 也失效', afterLogout.status === 401, `${afterLogout.status}/${afterLogout.body?.code}`)

// A disabled account must not be able to keep a session alive through its refresh token.
await call('POST', '/dsh-market/admin/users', { username: 'eve', password: 'eve-initial-2026' }, renewed.body.token)
const eveFirst = await call('POST', '/dsh-market/auth/login', { username: 'eve', password: 'eve-initial-2026' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'eve-password-2026' }, eveFirst.body.token)
const eve = await call('POST', '/dsh-market/auth/login', { username: 'eve', password: 'eve-password-2026' })
await call('POST', '/dsh-market/admin/status', { username: 'eve', status: 'disabled' }, renewed.body.token)
const eveRefresh = await call('POST', '/dsh-market/auth/refresh', { refresh: eve.body.refresh })
ok('账号被停用后 refresh 不再可用', eveRefresh.status === 401, `${eveRefresh.status}/${eveRefresh.body?.code}`)

console.log('')
console.log('结论：')
console.log('  · refresh 可兑换、每次轮换、旧令牌立刻失效（不能重放）。')
console.log('  · 登出会吊销 refresh —— 否则「登出」会在下一次请求时自动登回来。')
console.log('  · 账号停用后 refresh 立即失效。')

app.server.close()
app.db.close()
const { rmSync } = await import('node:fs')
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
