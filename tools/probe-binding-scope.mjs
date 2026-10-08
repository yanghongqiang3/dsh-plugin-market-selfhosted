/**
 * Does binding restrict WHERE a market account can be used?
 *
 * The question: a market account bound to DSH account A — can it log in on a client
 * running DSH account B?
 *
 * This measures what the service actually does, rather than reading the binding code and
 * reasoning about it. Binding is a 1:1 RECORD; the question is whether it is also an
 * ENFORCEMENT point.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-bindwhere-'))
const app = createApp({ dbFile: join(workDir, 'market.db'), storageDir: join(workDir, 'storage') })
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

// The bootstrap admin, then a second member whose password we set.
const adminLogin = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })
let adminToken = adminLogin.body.token
const changed = await call('POST', '/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, adminToken)
ok('管理员首登改密', changed.status === 200, `status=${changed.status}`)
adminToken = (await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body.token

// alice: a member who must change the initial password before anything else.
//
// The first version skipped this and every later step failed with
// `E_MUST_CHANGE_PASSWORD` — a failure caused by the fixture, not by the behaviour under
// test. Same trap as the earlier binding test.
const created = await call('POST', '/dsh-market/admin/users', { username: 'alice', password: 'alice-password-2026' }, adminToken)
ok('建成员 alice', created.status === 200, `status=${created.status}`)

const firstLogin = await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-password-2026' })
ok('alice 首登成功', firstLogin.status === 200, `status=${firstLogin.status}`)
const aliceChanged = await call(
  'POST',
  '/dsh-market/auth/password',
  { newPassword: 'alice-new-password-2026' },
  firstLogin.body.token,
)
ok('alice 首登改密', aliceChanged.status === 200, `status=${aliceChanged.status}`)

// alice binds HER market account to DSH account `dsh-alice`.
const aliceToken = (await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-new-password-2026' })).body.token
const bound = await call('POST', '/dsh-market/identity/bind', { dshUserId: 'dsh-alice', dshName: 'Alice 的本机' }, aliceToken)
ok('alice 的市场账号绑到 dsh-alice', bound.status === 200, JSON.stringify(bound.body?.binding))

// ------------------------------------------------------------------ the question
// Now sign in with the SAME market account from a machine that presents a DIFFERENT DSH
// account. Login carries no identity at all, so this is expected to succeed — the point
// is to measure it rather than assume.
const foreignLogin = await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-new-password-2026' })
ok('同一市场账号能在别处再次登录（携带的是别的 DSH 账号）', foreignLogin.status === 200, `status=${foreignLogin.status}`)

const foreignToken = foreignLogin.body?.token
const me = await call('GET', '/dsh-market/auth/me', undefined, foreignToken)
ok('这个新会话可以正常用', me.status === 200 && me.body?.user?.username === 'alice', JSON.stringify(me.body?.user?.username))

// And its binding is unchanged: still pointing at dsh-alice, even though this session is
// supposedly on a different DSH account.
const bindingNow = await call('GET', '/dsh-market/identity/me', undefined, foreignToken)
ok(
  '绑定仍是 dsh-alice（登录不改变绑定）',
  bindingNow.body?.binding?.dshUserId === 'dsh-alice',
  JSON.stringify(bindingNow.body?.binding?.dshUserId),
)

// Can that foreign session bind the OTHER DSH account, taking it over? It must NOT be
// able to: alice's market account is already bound.
// Conflict is 409, not 400 — the first version asserted 400 and failed on its own
// guess rather than on the service's behaviour.
const rebind = await call('POST', '/dsh-market/identity/bind', { dshUserId: 'dsh-bob', dshName: 'B 的本机' }, foreignToken)
ok(
  '已绑定的市场账号不能再绑第二个 DSH 账号',
  rebind.status === 409 && rebind.body?.code === 'E_MARKET_ALREADY_BOUND',
  `${rebind.status}/${rebind.body?.code}`,
)

// The DSH side is likewise still held by alice.
const lookup = await call('GET', '/dsh-market/identity/lookup?dshUserId=dsh-bob')
ok('dsh-bob 仍是空闲（没被偷偷占用）', lookup.body?.bound === false, JSON.stringify(lookup.body))

console.log('')
console.log('结论：')
console.log('  · 绑定**不限制登录位置**：知道密码就能在任何机器、任何 DSH 账号下登录。')
console.log('  · 登录**不改变绑定**，也不能用已绑定的市场账号去绑第二个 DSH 账号。')
console.log('  · 所以绑定目前是「归属记录」，不是「使用限制」。')
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
app.server.close()
process.exit(problems ? 1 : 0)
