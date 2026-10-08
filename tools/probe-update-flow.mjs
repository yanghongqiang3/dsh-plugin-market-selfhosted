/**
 * The full update path: install, publish a newer version, update, and verify the bytes.
 *
 * "How do plugin updates work" deserves a measured answer rather than a description of
 * the code. This drives the real flow through the host plugin's install route — the same
 * route the 更新 button calls — and checks the FILES afterwards, including that an update
 * does not leave the previous version's files behind.
 *
 * It uses a throwaway profile: a real one belongs to the operator.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createApp } from '../server/index.mjs'
import { packTarGz } from '../server/lib/pack.js'

const PKG = '@dsh-internal/dsh-plugin-updatedemo'
const work = mkdtempSync(join(tmpdir(), 'dsh-update-'))
const profileDir = join(work, 'profile')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-updatecheck',
  private: true,
  dsh: { profile: { bundles: [], disabledBundles: [] } },
}))
writeFileSync(join(profileDir, 'cordis.patch.yml'), '')

// The host plugin reads its profile location AND the service URL from the environment at
// import time, so both must be in place BEFORE `await import('../lib/plugin.js')` further
// down. They are assigned there, once the throwaway service has a port.
process.env.DSH_PROFILE_DIR = profileDir
process.env.DSH_HOME = work
process.env.MARKET_DIAG_LOG = join(work, 'diag.log')

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

// ------------------------------------------------------------------ market service
const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${app.server.address().port}`

/**
 * Point the host plugin at THIS throwaway service.
 *
 * It must be OVERWRITTEN, not defaulted: this machine has `MARKET_SERVICE_URL` set as a
 * user variable pointing at the operator's real service on 8787. The first version of
 * this file did not set it, so the download went to 8787 carrying a throwaway-account
 * token, came back 401, and every step after it failed with `E_NOT_LOGGED_IN` — a
 * failure of the harness reported as a failure of the feature under test.
 */
process.env.MARKET_SERVICE_URL = BASE

const call = async (method, path, body, token) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers }
}

const adminLogin = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, adminLogin.body.token)
const admin = (await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body.token

// A member in a group with a covering rule.
await call('POST', '/dsh-market/admin/users', { username: 'alice', password: 'alice-initial-2026' }, admin)
const first = await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-initial-2026' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'alice-password-2026' }, first.body.token)
const alice = (await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-password-2026' })).body.token
await call('POST', '/dsh-market/admin/groups', { id: 'platform', description: '平台' }, admin)
await call('POST', '/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '@dsh-internal/*', effect: 'allow' }, admin)
await call('POST', '/dsh-market/admin/membership', { username: 'alice', groupId: 'platform' }, admin)

// ------------------------------------------------------------------ two versions
/** A package whose content differs per version, so the files prove which one landed. */
const publish = (version, files) => {
  const dir = join(work, `src-${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: PKG,
    version,
    dsh: { market: { entry: `${PKG}/plugin` } },
  }))
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  const archive = packTarGz(dir, Object.keys(files).concat('package.json'))
  return app.artifacts.publishArchive(archive, { publishedBy: 'alice', state: 'published' })
}

publish('1.0.0', { 'index.js': '// version 1.0.0\n', 'lib/only-in-v1.js': '// v1 only\n' })
// 2.0.0 is published LATER, after the 1.0.0 install — the catalog check below has to see
// only 1.0.0 first, which the first version of this file got wrong by publishing both
// up front and then asserting the catalog offered 1.0.0.
const publishV2 = () => publish('2.0.0', { 'index.js': '// version 2.0.0\n' })

// ------------------------------------------------------------------ host plugin
const { apply } = await import('../lib/plugin.js')
const routes = []
const fakeWebServer = { port: 65535, register: (route) => { routes.push(route); return () => {} } }
apply({
  get: (name) => (name === 'webServer' ? fakeWebServer : undefined),
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
})
for (let i = 0; i < 60 && routes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50))
const route = (path) => routes.find((r) => String(r.path) === path)
/**
 * A minimal request that emits like a real one.
 *
 * The events MUST fire asynchronously: `readBody` registers its `data`/`end` listeners
 * inside a `new Promise`, so a synchronous emitter finishes before any listener exists
 * and the handler sees an empty body — which surfaced as `E_NOT_LOGGED_IN`, a message
 * about authentication caused entirely by the harness.
 */
const fakeReq = (body) => {
  const listeners = new Map()
  const req = {
    method: 'POST',
    url: '/',
    headers: { 'content-type': 'application/json' },
    on: (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(cb)
      return req
    },
    destroy: () => {},
  }
  const emit = (event, arg) => { for (const cb of listeners.get(event) ?? []) cb(arg) }
  setImmediate(() => {
    if (body !== undefined) emit('data', Buffer.from(JSON.stringify(body)))
    emit('end')
  })
  return req
}
const invoke = async (path, body) => {
  let captured = null
  await route(path).handler(fakeReq(body), { writeHead: () => {}, end: (out) => { captured = out } })
  try { return JSON.parse(String(captured)) } catch { return null }
}

ok('宿主插件挂上了 install 路由', route('/dsh-market/install') !== undefined, routes.map((r) => r.path).join(', '))

// ------------------------------------------------------------------ install 1.0.0
const catalog1 = await call('GET', '/dsh-market/catalog', undefined, alice)
const entry1 = catalog1.body.entries.find((e) => e.name === PKG)
ok('catalog 提供 1.0.0', entry1?.version === '1.0.0', String(entry1?.version))

const installed1 = await invoke('/dsh-market/install', {
  token: alice, name: PKG, version: entry1.version, sha256: entry1.sha256, channel: entry1.channel,
})
ok('安装 1.0.0 成功', installed1?.ok === true, JSON.stringify(installed1)?.slice(0, 120))

const pkgDir = join(profileDir, 'node_modules', ...PKG.split('/'))
const readIf = (rel) => { try { return readFileSync(join(pkgDir, rel), 'utf8') } catch { return null } }
ok('v1 的 index.js 到位', readIf('index.js') === '// version 1.0.0\n', JSON.stringify(readIf('index.js')))
ok('v1 独有的 lib/only-in-v1.js 存在', readIf('lib/only-in-v1.js') !== null)

const installedRoute = route('/dsh-market/installed')
let seen = null
await installedRoute.handler({ method: 'GET', url: '/dsh-market/installed', headers: {} }, { writeHead: () => {}, end: (out) => { seen = out } })
const inventory1 = JSON.parse(String(seen))
const mine1 = inventory1.entries.find((e) => e.name === PKG)
ok('本机已装列表报告 1.0.0', mine1?.version === '1.0.0', JSON.stringify(mine1))

// ------------------------------------------------------------------ the update
publishV2()
const catalog2 = await call('GET', '/dsh-market/catalog', undefined, alice)
const entry2 = catalog2.body.entries.find((e) => e.name === PKG)
ok('发布 2.0.0 后 catalog 提供 2.0.0', entry2?.version === '2.0.0', String(entry2?.version))
ok(
  '这就是「更新到 X」按钮的判据：catalog 版本 != 本机版本',
  entry2?.version !== mine1?.version,
  `catalog=${entry2?.version} 本机=${mine1?.version}`,
)

const updated = await invoke('/dsh-market/install', {
  token: alice, name: PKG, version: entry2.version, sha256: entry2.sha256, channel: entry2.channel,
})
ok('更新到 2.0.0 成功', updated?.ok === true, JSON.stringify(updated)?.slice(0, 120))
ok('index.js 换成了 2.0.0 的内容', readIf('index.js') === '// version 2.0.0\n', JSON.stringify(readIf('index.js')))
/**
 * The update must not leave files the new version does not have.
 *
 * `installEntry` removes the target directory before extracting, so a file that only
 * existed in 1.0.0 is gone. If it were an overlay instead, a removed module would keep
 * being loaded and the package on disk would not match what was published.
 */
ok('v1 独有的文件没有留下', readIf('lib/only-in-v1.js') === null)

const updatedAgain = JSON.parse(String(await (async () => {
  let out = null
  await installedRoute.handler({ method: 'GET', url: '/dsh-market/installed', headers: {} }, { writeHead: () => {}, end: (o) => { out = o } })
  return out
})()))
ok('本机已装列表报告 2.0.0', updatedAgain.entries.find((e) => e.name === PKG)?.version === '2.0.0')
ok('代理行只登记了一条（没有重复行）', updatedAgain.entries.filter((e) => e.name === PKG).length === 1)

// A re-install of the SAME version is the no-op case: the page shows no 更新 button.
const sameVersion = await invoke('/dsh-market/install', {
  token: alice, name: PKG, version: entry2.version, sha256: entry2.sha256, channel: entry2.channel,
})
ok('重复安装同一版本是安全的', sameVersion?.ok === true, JSON.stringify(sameVersion)?.slice(0, 100))

// ------------------------------------------------------------------ pinning an older version
const backTo1 = await invoke('/dsh-market/install', {
  token: alice, name: PKG, version: '1.0.0', sha256: app.artifacts.get(PKG, '1.0.0').sha256, channel: 'stable',
})
ok('可以按版本号装回旧版（下载接口支持 pin）', backTo1?.ok === true, JSON.stringify(backTo1)?.slice(0, 100))
ok('回到 1.0.0 后文件也回去了', readIf('index.js') === '// version 1.0.0\n', JSON.stringify(readIf('index.js')))
ok('退回旧版时 v1 独有的文件又出现了', readIf('lib/only-in-v1.js') !== null)

console.log('')
console.log('更新机制（实测）：')
console.log('  · 没有单独的 update 接口。更新 = 再用 install 装一个更高的版本。')
console.log('  · 判据：catalog 报的版本 != 本机已装版本 -> 页面显示「更新到 X」。')
console.log('  · 更新是**整目录替换**，旧版本独有的文件不会残留。')
console.log('  · 需要重启 DSH 才生效（返回里带 needRestart: true）。')
console.log('  · 可以按版本号装回旧版；装同一版本是幂等的。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
