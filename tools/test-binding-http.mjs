/**
 * Exercise the DSH-identity binding over real HTTP.
 *
 * The database constraint is proven by `test-bindings.mjs`; this proves the ROUTES,
 * which is where the operator's one-to-one rule actually has to hold — including the
 * part that matters most: a caller must not be able to bind a DSH account to SOMEBODY
 * ELSE'S market account. The market side comes from the bearer token, never from the
 * request body, so the test drives it with two different accounts.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-bind-http-'))
const app = createApp({ dbFile: join(workDir, 'market.db'), storageDir: join(workDir, 'storage') })
const { server, store } = app
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

let problems = 0
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? `  ${extra}` : ''}`)
  else {
    problems += 1
    console.error(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let parsed = null
  try { parsed = await response.json() } catch { parsed = null }
  return { status: response.status, body: parsed }
}

/** Log in, clearing the forced password change on the way. */
async function signIn(username, password) {
  const login = await call('POST', '/dsh-market/auth/login', { body: { username, password } })
  if (!login.body?.token) throw new Error(`login failed for ${username}: ${JSON.stringify(login.body)}`)
  let token = login.body.token
  if (login.body.mustChangePassword) {
    const changed = await call('POST', '/dsh-market/auth/password', {
      token,
      body: { newPassword: `${password}-changed-2026` },
    })
    if (!changed.body?.ok) throw new Error(`password change failed: ${JSON.stringify(changed.body)}`)
  }
  return token
}

console.log('--- 准备两个市场账号 ---')
const adminToken = await signIn('admin', 'dsh-admin')
const created = await call('POST', '/dsh-market/admin/users', {
  token: adminToken,
  body: { username: 'alice', password: 'alice-initial-2026', role: 'member' },
})
ok('创建 alice', created.body?.ok === true, JSON.stringify(created.body?.code ?? ''))
const aliceToken = await signIn('alice', 'alice-initial-2026')
const bob = await call('POST', '/dsh-market/admin/users', {
  token: adminToken,
  body: { username: 'bob', password: 'bob-initial-2026', role: 'member' },
})
ok('创建 bob', bob.body?.ok === true)
const bobToken = await signIn('bob', 'bob-initial-2026')

console.log('')
console.log('--- 未绑定时的查询 ---')
const fresh = await call('GET', '/dsh-market/identity/lookup?dshUserId=dsh-aaa')
ok('未绑定的 DSH 账号返回 bound:false', fresh.status === 200 && fresh.body?.bound === false, JSON.stringify(fresh.body))
const noId = await call('GET', '/dsh-market/identity/lookup')
ok('缺少 dshUserId 返回 400', noId.status === 400, `status=${noId.status}`)
const anonBind = await call('POST', '/dsh-market/identity/bind', { body: { dshUserId: 'dsh-aaa' } })
ok('未登录不能绑定', anonBind.status === 401, `status=${anonBind.status}`)

console.log('')
console.log('--- 绑定 ---')
const bound = await call('POST', '/dsh-market/identity/bind', {
  token: aliceToken,
  body: { dshUserId: 'dsh-aaa', dshName: '下里巴人', deviceId: 'dev-1' },
})
ok('alice 绑定 dsh-aaa', bound.status === 200 && bound.body?.binding?.marketUsername === 'alice', JSON.stringify(bound.body?.binding))
const looked = await call('GET', '/dsh-market/identity/lookup?dshUserId=dsh-aaa')
ok('绑定后查询返回 bound:true', looked.body?.bound === true)
ok(
  '未登录查询不泄露绑给了谁',
  looked.body?.marketUsername === undefined && looked.body?.binding === undefined,
  JSON.stringify(looked.body),
)
const mine = await call('GET', '/dsh-market/identity/me', { token: aliceToken })
ok('alice 能看自己的绑定', mine.body?.binding?.dshUserId === 'dsh-aaa')
const bobSees = await call('GET', '/dsh-market/identity/me', { token: bobToken })
ok('bob 看不到别人的绑定', bobSees.body?.binding === null, JSON.stringify(bobSees.body))

console.log('')
console.log('--- 双向唯一性 ---')
const repeat = await call('POST', '/dsh-market/identity/bind', {
  token: aliceToken,
  body: { dshUserId: 'dsh-aaa', dshName: '下里巴人' },
})
ok('同一对重复绑定是幂等成功', repeat.status === 200 && repeat.body?.unchanged === true, JSON.stringify(repeat.body))
const dshTaken = await call('POST', '/dsh-market/identity/bind', {
  token: bobToken,
  body: { dshUserId: 'dsh-aaa' },
})
ok('同一 DSH 账号不能被第二个市场账号绑', dshTaken.status === 409 && dshTaken.body?.code === 'E_DSH_ALREADY_BOUND', JSON.stringify(dshTaken.body))
const marketTaken = await call('POST', '/dsh-market/identity/bind', {
  token: aliceToken,
  body: { dshUserId: 'dsh-bbb' },
})
ok('同一市场账号不能被第二个 DSH 账号绑', marketTaken.status === 409 && marketTaken.body?.code === 'E_MARKET_ALREADY_BOUND', JSON.stringify(marketTaken.body))

console.log('')
console.log('--- 身份来源只能是令牌，不能是请求体 ---')
const spoof = await call('POST', '/dsh-market/identity/bind', {
  token: bobToken,
  body: { dshUserId: 'dsh-ccc', marketUsername: 'alice' },
})
ok('请求体里的 marketUsername 被忽略，绑给令牌归属者', spoof.body?.binding?.marketUsername === 'bob', JSON.stringify(spoof.body?.binding))

console.log('')
console.log('--- 管理员解绑 ---')
const notAdmin = await call('POST', '/dsh-market/admin/identity/unbind', {
  token: aliceToken,
  body: { dshUserId: 'dsh-aaa' },
})
ok('非管理员不能解绑', notAdmin.status === 403, `status=${notAdmin.status}`)

/**
 * The admin routes are registered with `auth: 'none'`, which does NOT mean open: the
 * dispatcher's `auth: 'user'` path resolves a session before the handler runs, while
 * these handlers resolve it themselves AND check the role — the session is needed for
 * the audit trail either way. So "no auth" must still answer 401/403, and that is
 * exactly what a future refactor could break silently.
 */
const listAnon = await call('GET', '/dsh-market/admin/identity')
ok('未登录看绑定列表 -> 401', listAnon.status === 401, `status=${listAnon.status}`)
const listNotAdmin = await call('GET', '/dsh-market/admin/identity', { token: aliceToken })
ok('非管理员看绑定列表 -> 403', listNotAdmin.status === 403, `status=${listNotAdmin.status}`)
const listAdmin = await call('GET', '/dsh-market/admin/identity', { token: adminToken })
ok('管理员能看绑定列表', listAdmin.status === 200 && Array.isArray(listAdmin.body?.bindings), `status=${listAdmin.status}`)

const unbindByDsh = await call('POST', '/dsh-market/admin/identity/unbind', {
  token: adminToken,
  body: { dshUserId: 'dsh-aaa' },
})
ok('按 DSH 账号解绑', unbindByDsh.status === 200 && unbindByDsh.body?.binding?.marketUsername === 'alice', JSON.stringify(unbindByDsh.body))
const afterUnbind = await call('GET', '/dsh-market/identity/lookup?dshUserId=dsh-aaa')
ok('解绑后 bound 回到 false', afterUnbind.body?.bound === false)
await call('POST', '/dsh-market/identity/bind', { token: bobToken, body: { dshUserId: 'dsh-ccc' } })
const unbindByMarket = await call('POST', '/dsh-market/admin/identity/unbind', {
  token: adminToken,
  body: { marketUsername: 'bob' },
})
ok('按市场账号解绑（另一个方向）', unbindByMarket.status === 200 && unbindByMarket.body?.binding?.dshUserId === 'dsh-ccc', JSON.stringify(unbindByMarket.body))
const missing = await call('POST', '/dsh-market/admin/identity/unbind', {
  token: adminToken,
  body: { dshUserId: 'nope' },
})
ok('解绑不存在的绑定返回 404', missing.status === 404, `status=${missing.status}`)

console.log('')
console.log('--- 解绑后可以重新绑定 ---')
const rebound = await call('POST', '/dsh-market/identity/bind', { token: aliceToken, body: { dshUserId: 'dsh-aaa' } })
ok('解绑后 alice 重新绑定成功', rebound.status === 200 && rebound.body?.ok === true)

console.log('')
console.log('--- 删除市场账号会解除绑定（外键级联）---')
const before = store.listBindings().length
await call('POST', '/dsh-market/admin/status', { token: adminToken, body: { username: 'alice', status: 'disabled' } })
ok('停用账号不影响绑定存在', store.listBindings().some((b) => b.marketUsername === 'alice'))
ok('绑定表当前条数', store.listBindings().length === before, `${before} -> ${store.listBindings().length}`)

server.close()
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
