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
import { fileURLToPath } from 'node:url'
import { createApp } from '../server/index.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-autologin-'))
const profileDir = join(work, 'profile')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-autologin', private: true,
  dsh: { profile: { bundles: ['dsh-plugin-market-internal'], disabledBundles: [] } },
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
    // `body` must be passed (even as `{}`) for a POST: without a `data` event `readBody` never
    // resolves, and the route silently never answers. That asymmetry is why every GET call in
    // this file was hiding the very defect it should have caught.
    if (method === 'POST' && body !== undefined) emit('data', Buffer.from(JSON.stringify(body)))
    emit('end')
  })
  await route(path).handler(req, { writeHead: () => {}, end: (out) => { captured = out } })
  try { return { status: 200, body: JSON.parse(String(captured)) } } catch { return { status: 0, body: null } }
}

/**
 * The `Origin` rule, stated as the page must obey it.
 *
 * A browser attaches `Origin` to a POST but NOT to a same-origin GET — so every read the page
 * needs must be a POST. This was learned the expensive way: the page's `GET /dsh-market/link`
 * and `GET /dsh-market/session` were answered `403 E_FOREIGN_ORIGIN` on the operator's machine
 * while the arming POST succeeded, which is exactly "enabling it works, reloading says it is
 * off". The assertions below pin both halves: a foreign Origin is refused, and the page uses
 * POST for every call it makes.
 */
const foreignLink = await invoke('/dsh-market/link', { origin: 'https://evil.example', body: { dshUserId: 'x', secret: 'y' } })
ok('外部 Origin 不能写密钥', foreignLink.body?.code === 'E_FOREIGN_ORIGIN', JSON.stringify(foreignLink.body))
const foreignSession = await invoke('/dsh-market/session', { origin: 'https://evil.example', body: {} })
ok('外部 Origin 不能索取会话', foreignSession.body?.code === 'E_FOREIGN_ORIGIN', JSON.stringify(foreignSession.body))
const noOrigin = await invoke('/dsh-market/session', { origin: null, body: {} })
ok('没有 Origin 的请求也被拒（浏览器对同源 GET 正是这样）', noOrigin.body?.code === 'E_FOREIGN_ORIGIN', JSON.stringify(noOrigin.body))

const stored = await invoke('/dsh-market/link', { body: { dshUserId: 'dsh-alice-1', secret: fresh.body.secret, marketUsername: 'alice' } })
ok('本机 Origin 可以写入密钥', stored.body?.ok === true, JSON.stringify(stored.body))
const linkFile = join(profileDir, '.dsh-market-link.json')
ok('  密钥落到了 profile 里的文件', existsSync(linkFile))
ok('  文件里没有明文密钥泄漏到别处', JSON.parse(readFileSync(linkFile, 'utf8')).secret === fresh.body.secret)

const session = await invoke('/dsh-market/session', { body: {} })
ok('插件能换到会话（这就是自动登录）', session.body?.ok === true && typeof session.body?.session?.token === 'string', JSON.stringify(session.body).slice(0, 120))
ok('  含 refresh', typeof session.body?.session?.refresh === 'string')

/**
 * The link route must ANSWER, not only write.
 *
 * The market page cannot read the profile, so this route is the only way it can learn
 * whether auto-login is armed outside of a sign-in. It did not answer at all: a body with
 * neither `secret` nor `clear` fell through to `writeLink('')`, which threw and returned
 * 400. The page therefore tracked arming in a variable that a successful enable never
 * updated, drew 「此设备已关闭自动登录」 under a toast saying it had just been enabled, and
 * kept saying it until a reload.
 */
const readBack = await invoke('/dsh-market/link', { body: {} })
ok('读取密钥状态：有密钥时报 hasSecret=true', readBack.body?.ok === true && readBack.body?.hasSecret === true, JSON.stringify(readBack.body))
ok('  写入也回报同一个状态（页面据此立即纠正那一行）', stored.body?.hasSecret === true, JSON.stringify(stored.body))
/**
 * An early page load must not look like a failure.
 *
 * Before a secret exists the page passes nothing, which used to be a write of an empty
 * secret — a 400. "Not armed yet" is an answer, not an error. The secret is cleared first
 * because this runs after the write above, so otherwise it would only prove the read path
 * agrees with a file that does exist.
 */
await invoke('/dsh-market/link', { body: { clear: true } })
const notArmedYet = await invoke('/dsh-market/link', { method: 'POST', body: {} })
ok('尚未启用时读取不报错，而是明确回答 hasSecret=false', notArmedYet.status === 200 && notArmedYet.body?.hasSecret === false, `status=${notArmedYet.status} ${JSON.stringify(notArmedYet.body)}`)
// Put it back: the session assertions below depend on an armed secret.
await invoke('/dsh-market/link', { body: { dshUserId: 'dsh-alice-1', secret: fresh.body.secret, marketUsername: 'alice' } })

if (session.body?.session?.token) {
  const usable = await call('GET', '/dsh-market/auth/me', undefined, session.body.session.token)
  ok('  这个会话可用于 API', usable.status === 200 && usable.body?.user?.username === 'alice', String(usable.status))
}

const cleared = await invoke('/dsh-market/link', { body: { clear: true } })
ok('可以清除本机密钥', cleared.body?.ok === true && !existsSync(linkFile), JSON.stringify(cleared.body))
ok('  清除后也如实回报 hasSecret=false', cleared.body?.hasSecret === false, JSON.stringify(cleared.body))
const afterClear = await invoke('/dsh-market/session', { body: {} })
ok('清除后不再自动登录', afterClear.body?.session === null && afterClear.body?.reason === 'E_NO_LOCAL_SECRET', JSON.stringify(afterClear.body))

console.log('')
console.log('--- 退出登录必须关掉自动登录（否则「退出」是个谎话）---')
/**
 * The question this answers: 「在安装页点了退出，下次打开会自动登录吗？」
 *
 * It DID. The page cleared the session and the refresh token but not the plugin's device
 * secret, so the next visit asked the plugin for a session and silently signed back in.
 * The page now clears the secret on logout; this pins the MECHANISM (a cleared secret
 * cannot be exchanged) and the preflight asserts the page actually does it.
 */
await invoke('/dsh-market/link', { body: { dshUserId: 'dsh-alice-1', secret: fresh.body.secret, marketUsername: 'alice' } })
const armed = await invoke('/dsh-market/session', { body: {} })
ok('清掉之前：密钥可用，会自动登录', armed.body?.session?.token !== undefined && armed.body?.hasSecret === true)
await invoke('/dsh-market/link', { body: { clear: true } })
const disarmed = await invoke('/dsh-market/session', { body: {} })
ok('清掉之后：不再自动登录', disarmed.body?.session === null && disarmed.body?.reason === 'E_NO_LOCAL_SECRET')
ok('  且如实报告本机没有密钥（页面据此提示可重新启用）', disarmed.body?.hasSecret === false)
// Clearing the secret is NOT unbinding: the slot is unchanged.
const stillBound = await call('GET', '/dsh-market/identity/lookup?dshUserId=dsh-alice-1')
ok('  绑定本身不受影响（只是本机不再自动登录）', stillBound.body?.bound === true, JSON.stringify(stillBound.body))
// And it can be armed again without unbinding first — the bind is idempotent and mints a
// fresh secret, which is what the binding row's 「在此设备启用自动登录」 button calls.
const rearm = await call('POST', '/dsh-market/identity/bind', { dshUserId: 'dsh-alice-1', dshName: 'Alice' }, alice)
ok('  可以就地重新启用（不必先解绑）', rearm.status === 200 && rearm.body?.unchanged === true && typeof rearm.body?.secret === 'string')
await invoke('/dsh-market/link', { body: { dshUserId: 'dsh-alice-1', secret: rearm.body.secret } })
const rearmed = await invoke('/dsh-market/session', { body: {} })
ok('  重新启用后又能自动登录', rearmed.body?.session?.token !== undefined, String(rearmed.body?.reason ?? ''))

console.log('')
console.log('--- 页面必须按宿主的回答画那一行，不能自己记一个可能过期的状态 ---')
/**
 * The self-contradiction, pinned at the source.
 *
 * The page drew the binding row from `linkStored`, which was only ever assigned inside
 * `tryAutoLogin` — and that returns EARLY when the DSH account is unreadable, which is a
 * normal state. So the row could say 「此设备已关闭自动登录」 while the file on disk said
 * otherwise, and it was never re-read after a successful enable. Both halves are asserted
 * here: a function that asks the host, and the enable path keeping the flag in step.
 */
{
  // `path` is the local route finder in this file, and it shadows `node:path`'s join here.
  const pageFile = fileURLToPath(new URL('../web/market.html', import.meta.url))
  const pageSource = readFileSync(pageFile, 'utf8')
  // Bound to names: a line starting with `/` after a line ending in `)` is DIVISION, which
  // is how this file was briefly a syntax error — the same trap run-all.mjs warns about.
  // The window is generous on purpose: `readLinkState` carries a long comment before its
  // body, and a tight bound here fails on the COMMENT rather than on the behaviour. The
  // optional-chaining `?` must be escaped as `\?` — written bare it is a quantifier, and
  // the assertion silently tests for a string that cannot exist.
  const asksHostForState = /async function readLinkState\(\)[\s\S]{0,2500}?'\/dsh-market\/link'/.test(pageSource)
  const keepsFlagInStep = /linkStored = result\?\.body\?\.hasSecret === true/.test(pageSource)
  const readsOnBoot = /await readLinkState\(\)/.test(pageSource)
  // `ok(label, condition)` takes the CONDITION as its second argument. These four were first
  // written as `ok('label') ? ok('…') : fail('…')` — a valid call with no condition, so it
  // counted a failure per line while the values above were all true. A one-argument `ok` is
  // always a mistake; it is the shape to grep for when an assertion contradicts its debug.
  ok('页面有专门的「问宿主」入口（readLinkState）', asksHostForState)
  ok('  写入成功后立刻按宿主回答纠正 linkStored', keepsFlagInStep)
  ok('  启动时先读真实状态，再决定画什么', readsOnBoot)
  ok('  「已关闭」这句仍在（它本身是对的，错的是判定来源）', pageSource.includes('此设备已关闭自动登录'))
  /**
   * BOTH states must be stated. With only the disabled one labelled, "armed" was drawn as a
   * bare bound row and a 解绑 button — indistinguishable from "the page could not find out",
   * which is the same ambiguity this row was fixed for, pointing the other way.
   *
   * The regex pairs the sentence with the `linkStored` branch that must own it, so moving it
   * into the wrong branch (or into a toast) fails here rather than in the operator's browser.
   */
  ok('  「已开启」也明说（否则与"查不到"长得一样）', pageSource.includes('此设备已开启自动登录'))
  const enabledStated = /\} else \{\s*\n\s*line\.textContent \+= '\\n此设备已开启自动登录/.test(pageSource)
  ok('  且它挂在 linkStored 为真的那一支上', enabledStated)

  /**
   * The ORDER inside `tryAutoLogin` is the fix, and nothing else pins it.
   *
   * The read must come BEFORE the `dshIdentity.source !== 'account'` gate. That gate is a
   * normal state — the DSH account read needs the network and is best-effort — and while the
   * read sat after it, the row fell back to "not armed" on exactly those boots. Measured by
   * running both page revisions against one live instance with the identity forced to
   * `device-only`: the old page drew 「此设备已关闭自动登录」 under a bound row, the new one does
   * not. An assertion that only checked "readLinkState exists" would have passed the broken
   * layout, which is why this compares positions.
   */
  const tryAutoLoginBody = (/async function tryAutoLogin\(\) \{([\s\S]*?)\n\}/.exec(pageSource) ?? [])[1] ?? ''
  const readAt = tryAutoLoginBody.indexOf('await readLinkState()')
  const gateAt = tryAutoLoginBody.indexOf("dshIdentity.source !== 'account'")
  ok(
    '读状态排在身份判断之前（账号读不出时那一行也准确）',
    readAt !== -1 && gateAt !== -1 && readAt < gateAt,
    `read@${readAt} gate@${gateAt}`,
  )

  /**
   * Every call to an Origin-GUARDED route must be a POST.
   *
   * This is the assertion that would have caught the real defect. Only three routes call
   * `ownOrigin` — `/link`, `/session` and `/recalled/dismiss` — and the browser sends `Origin`
   * on POST but NOT on a same-origin GET, so ANY GET to one of them is a 403 in a real browser.
   * Every probe here missed it, because `invoke()` defaults to POST and omitting the method
   * happened to be correct.
   *
   * The allowlist is deliberately explicit rather than scraped from `lib/plugin.js`: if a future
   * route starts guarding on Origin, this assertion should FAIL and make someone look, not
   * silently follow it. `/config`, `/installed`, `/recalled` and `/identity` are open on
   * purpose — they serve the same public page and carry no credential.
   */
  const guardedRoutes = ['/dsh-market/link', '/dsh-market/session', '/dsh-market/recalled/dismiss']
  const hostCalls = [...pageSource.matchAll(/local\(\s*'([^']+)'((?:[^()]|\([^()]*\))*)\)/g)]
    .map((match) => ({ path: match[1], args: match[2] }))
  const guardedGets = hostCalls.filter(
    (call) => guardedRoutes.includes(call.path) && !call.args.includes("method: 'POST'"),
  )
  ok(
    '受 Origin 保护的接口一律用 POST（同源 GET 不带 Origin，必然 403）',
    guardedGets.length === 0,
    guardedGets.length ? `仍是 GET/无 method: ${guardedGets.map((c) => c.path).join(', ')}` : `${guardedRoutes.length} 条受保护路由`,
  )
  // An `<a href>`/`location` navigation carries no Origin either, so a guarded route must
  // never be reached that way — asserted separately so a future refactor cannot reintroduce it
  // by moving the call out of `local()`.
  const navigations = guardedRoutes.filter(
    (route) => pageSource.includes(`href="${route}"`) || pageSource.includes(`location.href = '${route}'`),
  )
  ok('受保护接口没有被当作导航目标（导航同样没有 Origin）', navigations.length === 0, navigations.join(', '))
}

console.log('')
console.log('--- shared.js 必须导出页面真正调用的东西 ---')
/**
 * `S.setMe` is called by the page's auto-login and was NOT on `MarketShell`.
 *
 * Measured with the page run against a live instance: `S.setMe is not a function` was the
 * last thing `tryAutoLogin` did — after the token had been stored, so the failure landed
 * between "session obtained" and "user published" and surfaced only as an unhandled
 * rejection. Nothing in this suite could see it, because no test executed the page.
 */
{
  const pageFile = fileURLToPath(new URL('../web/market.html', import.meta.url))
  const pageSource = readFileSync(pageFile, 'utf8')
  const shellSource = readFileSync(fileURLToPath(new URL('../web/shared.js', import.meta.url)), 'utf8')
  const exported = (/global\.MarketShell = \{([\s\S]*?)\n  \}/.exec(shellSource) ?? [])[1] ?? ''
  const calledByPage = [...pageSource.matchAll(/\bS\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1])
  const missing = [...new Set(calledByPage)].filter((name) => !new RegExp(`\\b${name}\\b`).test(exported))
  ok(
    '页面调用的每个 MarketShell 方法都真的导出了',
    missing.length === 0,
    missing.length ? `缺: ${missing.join(', ')}` : '',
  )
}

console.log('')
console.log('结论：')
console.log('  · 「自动登录」= DSH 账号已绑定 + 本机持有绑定密钥；账号 ID 本身换不到会话。')
console.log('  · 密钥只在绑定时下发一次，读取接口不返回它，重绑会轮换、解绑即失效。')
console.log('  · 密钥由宿主插件保管，页面只向插件要会话；插件拒绝一切外部 Origin 的请求。')
console.log('  · 退出登录会清掉本机密钥，所以退出之后不会再被自动登回来；')
console.log('    绑定不受影响，且可就地重新启用。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
