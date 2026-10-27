/**
 * Installation statistics: who installed what, and how many people/devices/downloads.
 *
 * The service cannot see a profile. Before this existed it had `download` audit rows and
 * nothing else, so "installed" was a guess: a download is not an install (it can fail to
 * extract, be repeated for an update, be uninstalled, or be recalled). The client therefore
 * reports its SNAPSHOT of installed items; this probe drives that path for real.
 *
 * Properties worth pinning, because each fails by quietly showing a plausible wrong number:
 *
 *   - a successful page install reports automatically (no extra user action);
 *   - an uninstall removes the item instead of leaving a stale row;
 *   - one account on two devices is ONE person but TWO devices;
 *   - two accounts with the same plugin are TWO people;
 *   - a repeated report is idempotent (no duplicate rows, no inflated counts);
 *   - identity comes from the token, never from the body;
 *   - unknown package names are dropped, malformed names are refused;
 *   - the startup report uses the binding secret and works with no browser present.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'
import { packTarGz } from '../server/lib/pack.js'

const work = mkdtempSync(join(tmpdir(), 'dsh-install-stats-'))
const profileDir = join(work, 'profile')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-install-stats', private: true,
  dsh: { profile: { bundles: ['dsh-plugin-market-internal'], disabledBundles: [] } },
}))
writeFileSync(join(profileDir, 'cordis.patch.yml'), '')

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${app.server.address().port}`
process.env.MARKET_SERVICE_URL = BASE
process.env.DSH_PROFILE_DIR = profileDir
process.env.DSH_HOME = work
process.env.MARKET_DIAG_LOG = join(work, 'diag.log')
process.env.MARKET_AUTO_RECALL = ''
process.env.MARKET_AUTO_REPORT = ''
process.env.MARKET_SERVICE_TOKEN = ''

const post = async (path, body, token) => {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const get = async (path, token) => {
  const response = await fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/** Admin bootstrap, then a normal member so the two accounts can be told apart. */
const boot = (await post('/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })).body
await post('/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, boot.token)
const { token } = (await post('/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body
await post('/dsh-market/admin/groups', { id: 'platform', description: '平台' }, token)
await post('/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '*', effect: 'allow' }, token)
await post('/dsh-market/admin/membership', { username: 'admin', groupId: 'platform' }, token)

/** A member account, with no binding: its reports can only come from a page session. */
await post('/dsh-market/admin/users', {
  username: 'alice', password: 'alice-password-2026', mustChangePassword: false, groups: ['platform'],
}, token)
const alice = (await post('/dsh-market/auth/login', { username: 'alice', password: 'alice-password-2026' })).body

/** Publish a plugin through the real store path (the report route only accepts known names). */
const publish = (name, version) => {
  const dir = join(work, `src-${name.replace(/[@/]/g, '_')}-${version}`)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version, description: `${name} ${version}`, dsh: { market: {} },
  }))
  writeFileSync(join(dir, 'lib', 'plugin.js'), 'export function apply() {}\n')
  return app.artifacts.publishArchive(packTarGz(dir, ['package.json', 'lib/plugin.js']), {
    publishedBy: 'tester', state: 'published',
  })
}

const PLUGIN_A = '@dsh-internal/stats-plugin-a'
const PLUGIN_B = '@dsh-internal/stats-plugin-b'
publish(PLUGIN_A, '1.0.0')
publish(PLUGIN_B, '1.0.0')

/** Drive the plugin's own install/uninstall routes, so its reporting code runs for real. */
const { apply, reportStartupInventory } = await import('../lib/plugin.js')
const routes = []
const mount = () => {
  routes.length = 0
  apply({
    get: (name) => (name === 'webServer'
      ? { port: 17901, register: (route) => { routes.push(route); return () => {} } }
      : name === 'skills' ? { register: () => () => {} } : undefined),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  })
}
mount()
for (let i = 0; i < 80 && routes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50))
const route = (path) => routes.find((r) => String(r.path) === path)

const invoke = async (path, body, { origin = 'http://127.0.0.1:17901' } = {}) => {
  let captured = null
  const listeners = new Map()
  const req = {
    method: 'POST', url: path,
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    on: (event, cb) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return req },
    destroy: () => {},
  }
  const emit = (event, arg) => { for (const cb of listeners.get(event) ?? []) cb(arg) }
  setImmediate(() => { if (body !== undefined) emit('data', Buffer.from(JSON.stringify(body ?? {}))); emit('end') })
  let status = 200
  await route(path).handler(req, {
    writeHead: (code) => { status = code ?? 200 },
    end: (out) => { captured = out },
  })
  try { return { status, body: JSON.parse(String(captured)) } } catch { return { status, body: null } }
}

const install = async (name, version) => {
  const catalog = await (await fetch(`${BASE}/dsh-market/catalog?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  })).json()
  const entry = catalog.entries.find((e) => e.name === name && e.version === version)
  if (entry === undefined) throw new Error(`not in catalog: ${name}@${version}`)
  return invoke('/dsh-market/install', {
    token, name, version, sha256: entry.sha256, channel: entry.channel,
  })
}

/** Background reporting is deliberate; poll rather than assuming it finished. */
const waitFor = async (check, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await check()
    if (last?.ok === true) return last
    await new Promise((r) => setTimeout(r, 60))
  }
  return last
}

const accounts = async () => (await get('/dsh-market/admin/installs/accounts?limit=100', token)).body
const plugins = async () => (await get('/dsh-market/admin/installs/plugins?limit=100', token)).body
const account = (body, username) => body?.entries?.find((entry) => entry.username === username) ?? null
const plugin = (body, name) => body?.entries?.find((entry) => entry.name === name) ?? null

const DEVICE_AUTO = () => {
  try { return JSON.parse(readFileSync(join(profileDir, '.dsh-market-device.json'), 'utf8')).deviceId } catch { return null }
}

console.log('--- 页面安装后自动上报 ---')
{
  ok('初始时启动上报报告「没有绑定」', (await reportStartupInventory()).status === 'no-binding')
  const installed = await install(PLUGIN_A, '1.0.0')
  ok('插件安装成功', installed.body?.ok === true, JSON.stringify(installed.body).slice(0, 90))
  ok('  本机生成并持久化了 deviceId', typeof DEVICE_AUTO() === 'string' && DEVICE_AUTO().length >= 8)

  const waited = await waitFor(async () => {
    const body = await accounts()
    return account(body, 'admin')?.items?.some((item) => item.name === PLUGIN_A) ? { ok: true, body } : { ok: false, body }
  })
  const admin = account(waited.body, 'admin')
  ok('安装后无需额外操作就出现在「按账号」里', admin !== null, JSON.stringify(waited.body?.entries?.map((e) => e.username)))
  ok('  账号行里列出了这个插件', admin?.items?.some((item) => item.name === PLUGIN_A) === true,
    JSON.stringify(admin?.items))
  ok('  设备数为 1', admin?.deviceCount === 1, String(admin?.deviceCount))

  const byPlugin = await plugins()
  const a = plugin(byPlugin, PLUGIN_A)
  ok('「按插件」里安装人数为 1', a?.installers === 1, JSON.stringify(a))
  ok('  下载次数来自下载审计（≥1）', a?.downloads >= 1, String(a?.downloads))
  ok('  该账号确实是下载者（审计有记录）',
    (await get('/dsh-market/admin/users?limit=1', token)).body?.audit?.some(
      (entry) => entry.action === 'download' && entry.detail?.name === PLUGIN_A,
    ) === true)
}

console.log('')
console.log('--- 同账号第二台设备：人不变，设备 +1 ---')
{
  const report = await post('/dsh-market/installed/report', {
    deviceId: 'probe-device-b-0001',
    profile: 'desktop',
    items: [
      { name: PLUGIN_A, version: '1.0.0', kind: 'plugin' },
      { name: PLUGIN_B, version: '1.0.0', kind: 'plugin' },
    ],
  }, token)
  ok('第二台设备上报成功', report.status === 200 && report.body?.ok === true,
    `${report.status}/${report.body?.code}`)
  ok('  应答报告了新增项', Array.isArray(report.body?.added) && report.body.added.length === 2,
    JSON.stringify(report.body?.added))

  const body = await accounts()
  const admin = account(body, 'admin')
  ok('账号的插件数变成 2', admin?.pluginCount === 2, String(admin?.pluginCount))
  ok('  设备数变成 2', admin?.deviceCount === 2, String(admin?.deviceCount))

  const byPlugin = await plugins()
  ok('插件 A 仍是 1 个人', plugin(byPlugin, PLUGIN_A)?.installers === 1)
  ok('  但设备数是 2', plugin(byPlugin, PLUGIN_A)?.devices === 2, String(plugin(byPlugin, PLUGIN_A)?.devices))
  ok('插件 B 有 1 个人 / 1 台设备',
    plugin(byPlugin, PLUGIN_B)?.installers === 1 && plugin(byPlugin, PLUGIN_B)?.devices === 1,
    JSON.stringify(plugin(byPlugin, PLUGIN_B)))
  ok('  插件 B 没有下载记录也出现在表里（来自安装上报）',
    plugin(byPlugin, PLUGIN_B)?.downloads === 0, String(plugin(byPlugin, PLUGIN_B)?.downloads))
}

console.log('')
console.log('--- 第二个账号：人数才算 +1 ---')
{
  const report = await post('/dsh-market/installed/report', {
    deviceId: 'probe-device-c-0001',
    profile: 'web',
    items: [{ name: PLUGIN_A, version: '1.0.0', kind: 'plugin' }],
  }, alice.token)
  ok('alice 上报成功', report.status === 200 && report.body?.ok === true, `${report.status}/${report.body?.code}`)

  const body = await accounts()
  ok('账号列表现在有两个账号', body?.total === 2, String(body?.total))
  ok('  两个账号各自带插件清单',
    account(body, 'admin')?.items?.length === 2 && account(body, 'alice')?.items?.length === 1,
    JSON.stringify(body?.entries?.map((e) => [e.username, e.items.length])))
  ok('插件 A 安装人数变成 2', plugin(await plugins(), PLUGIN_A)?.installers === 2)

  // Repeated reports are the normal case (install, then boot): they must not inflate anything.
  const again = await post('/dsh-market/installed/report', {
    deviceId: 'probe-device-c-0001',
    profile: 'web',
    items: [{ name: PLUGIN_A, version: '1.0.0', kind: 'plugin' }],
  }, alice.token)
  ok('重复上报是幂等的', again.status === 200
    && again.body.added.length === 0 && again.body.removed.length === 0, JSON.stringify(again.body))
  const after = await accounts()
  ok('  设备数没有翻倍', account(after, 'alice')?.deviceCount === 1, String(account(after, 'alice')?.deviceCount))
  ok('  人数没有翻倍', plugin(await plugins(), PLUGIN_A)?.installers === 2)
}

console.log('')
console.log('--- 身份来自令牌，不来自请求体 ---')
{
  const before = await accounts()
  const report = await post('/dsh-market/installed/report', {
    username: 'alice', // must be ignored
    deviceId: 'probe-device-d-0001',
    items: [{ name: PLUGIN_B, version: '1.0.0', kind: 'plugin' }],
  }, token)
  ok('伪造 username 的上报被接受但归属令牌持有者', report.status === 200
    && report.body.username === 'admin', JSON.stringify(report.body?.username))
  const after = await accounts()
  ok('  设备记在 admin 名下', account(after, 'admin')?.deviceCount === (account(before, 'admin')?.deviceCount ?? 0) + 1)
  ok('  alice 的设备数没有变化', account(after, 'alice')?.deviceCount === account(before, 'alice')?.deviceCount)
}

console.log('')
console.log('--- 服务端校验上报内容 ---')
{
  const badName = await post('/dsh-market/installed/report', {
    deviceId: 'probe-device-e-0001',
    items: [{ name: '../escape', version: '1.0.0' }],
  }, token)
  ok('非法包名整单拒绝', badName.status === 400 && badName.body?.code === 'E_BAD_ITEM',
    `${badName.status}/${badName.body?.code}`)

  const badDevice = await post('/dsh-market/installed/report', {
    deviceId: 'short', items: [],
  }, token)
  ok('非法 deviceId 拒绝', badDevice.status === 400 && badDevice.body?.code === 'E_BAD_DEVICE',
    `${badDevice.status}/${badDevice.body?.code}`)

  const unknown = await post('/dsh-market/installed/report', {
    deviceId: 'probe-device-f-0001',
    items: [
      { name: '@dsh-internal/never-published', version: '1.0.0', kind: 'plugin' },
      { name: PLUGIN_A, version: '1.0.0', kind: 'plugin' },
    ],
  }, token)
  ok('未知包名被丢弃，已知的保留', unknown.status === 200
    && unknown.body.ignored === 1 && unknown.body.installed === 1, JSON.stringify(unknown.body))
  ok('  未知包名没有出现在插件统计里',
    (await plugins())?.entries?.every((entry) => entry.name !== '@dsh-internal/never-published') === true)

  const anon = await post('/dsh-market/installed/report', {
    deviceId: 'probe-device-g-0001', items: [],
  })
  ok('未登录上报 -> 401', anon.status === 401, String(anon.status))

  const memberRead = await get('/dsh-market/admin/installs/accounts', alice.token)
  ok('普通成员读统计 -> 403', memberRead.status === 403 && memberRead.body?.code === 'E_NOT_ADMIN',
    `${memberRead.status}/${memberRead.body?.code}`)

  const emptyInventory = await post('/dsh-market/installed/report', {
    deviceId: 'probe-device-f-0001', items: [],
  }, token)
  ok('空清单等价于全部移除', emptyInventory.status === 200
    && emptyInventory.body.installed === 0
    && emptyInventory.body.removed.includes(PLUGIN_A), JSON.stringify(emptyInventory.body?.removed))
}

console.log('')
console.log('--- 启动对账：只用绑定密钥，不需要浏览器 ---')
{
  // A real binding: the secret is what a machine has when no human is present.
  const bound = await post('/dsh-market/identity/bind', {
    dshUserId: 'dsh-stats-probe', dshName: '统计探针',
  }, token)
  ok('绑定成功并拿到一次性的密钥', bound.status === 200 && typeof bound.body?.secret === 'string',
    `${bound.status}/${bound.body?.code}`)
  writeFileSync(join(profileDir, '.dsh-market-link.json'), JSON.stringify({
    dshUserId: 'dsh-stats-probe', secret: bound.body.secret, marketUsername: 'admin', savedAt: Date.now(),
  }))

  const startup = await reportStartupInventory()
  ok('启动上报成功', startup.status === 'reported', JSON.stringify(startup).slice(0, 120))
  const body = await accounts()
  ok('  本机清单回到了账号上', account(body, 'admin')?.items?.some((item) => item.name === PLUGIN_A) === true)
  ok('  而且没有多出一台设备（deviceId 是持久的）',
    account(body, 'admin')?.deviceCount === 3, String(account(body, 'admin')?.deviceCount))

  process.env.MARKET_AUTO_REPORT = '0'
  const disabled = await reportStartupInventory()
  ok('MARKET_AUTO_REPORT=0 时可以关掉', disabled.status === 'disabled', JSON.stringify(disabled))
  process.env.MARKET_AUTO_REPORT = ''
}

console.log('')
console.log('--- 卸载后自动上报，计数会下降 ---')
{
  const beforePlugins = await plugins()
  const beforeAccounts = await accounts()
  ok('卸载前插件 A 有 3 台设备', plugin(beforePlugins, PLUGIN_A)?.devices === 3,
    `${plugin(beforePlugins, PLUGIN_A)?.devices}（本机 + B + C）`)
  ok('  卸载前 admin 有 3 台设备上报', account(beforeAccounts, 'admin')?.deviceCount === 3,
    String(account(beforeAccounts, 'admin')?.deviceCount))
  const removed = await invoke('/dsh-market/uninstall', { name: PLUGIN_A, token })
  ok('卸载成功', removed.body?.ok === true, JSON.stringify(removed.body).slice(0, 90))

  const waited = await waitFor(async () => {
    const body = await plugins()
    const entry = plugin(body, PLUGIN_A)
    return entry?.devices === 2 ? { ok: true, entry } : { ok: false, entry }
  })
  ok('卸载后插件 A 的设备数降到 2', waited.entry?.devices === 2, String(waited.entry?.devices))
  ok('  安装人数仍是 2（admin 还有另一台设备，alice 也还在）', waited.entry?.installers === 2,
    String(waited.entry?.installers))

  const body = await accounts()
  ok('  admin 的设备数降到 2', account(body, 'admin')?.deviceCount === 2,
    String(account(body, 'admin')?.deviceCount))
  ok('  admin 的清单里 A 还在（另一台设备上仍装着）',
    account(body, 'admin')?.items?.some((item) => item.name === PLUGIN_A) === true)
  ok('  插件 B 不受影响',
    account(body, 'admin')?.items?.some((item) => item.name === PLUGIN_B) === true)
}

console.log('')
console.log('--- 查询：搜索与分页 ---')
{
  const searched = await get('/dsh-market/admin/installs/accounts?q=alice', token)
  ok('按账号搜索只返回匹配项', searched.body?.total === 1
    && searched.body?.entries?.[0]?.username === 'alice', JSON.stringify(searched.body?.entries?.map((e) => e.username)))

  const byName = await get('/dsh-market/admin/installs/accounts?q=stats-plugin-b', token)
  ok('按插件名搜索账号', byName.body?.total >= 1
    && byName.body?.entries?.some((entry) => entry.username === 'admin') === true)

  const paged = await get('/dsh-market/admin/installs/plugins?limit=1', token)
  ok('分页 limit 生效', paged.body?.entries?.length === 1 && paged.body?.total >= 2,
    `${paged.body?.entries?.length}/${paged.body?.total}`)
  ok('  响应带覆盖信息', paged.body?.meta?.devices >= 3, JSON.stringify(paged.body?.meta))

  // The accounts table asks for counts for the accounts on screen, and only fetches one
  // account's inventory when its count is clicked.
  const narrowed = await get('/dsh-market/admin/installs/accounts?usernames=alice', token)
  ok('按账号缩小范围只返回该账号', narrowed.body?.total === 1
    && narrowed.body?.entries?.[0]?.username === 'alice', String(narrowed.body?.total))

  const one = await get('/dsh-market/admin/installs/account?username=alice', token)
  ok('点开某个账号才查它的安装明细', one.body?.ok === true
    && one.body?.username === 'alice'
    && one.body?.items?.some((item) => item.name === PLUGIN_A) === true,
    JSON.stringify(one.body?.items?.map((item) => item.name)))
  ok('  明细里没有 alice 没装的东西',
    one.body?.items?.every((item) => item.name !== PLUGIN_B) === true)
  const unknown = await get('/dsh-market/admin/installs/account?username=nobody-at-all', token)
  ok('不存在的账号 -> 404', unknown.status === 404, String(unknown.status))

  // The artifact list carries the same numbers, joined by name.
  const artifactList = await get('/dsh-market/admin/artifacts?limit=100', token)
  const artifactA = artifactList.body?.entries?.find((entry) => entry.name === PLUGIN_A)
  ok('制品列表每行带回安装人数与下载次数', artifactA?.installers === 2 && artifactA?.downloads >= 1,
    JSON.stringify({ installers: artifactA?.installers, downloads: artifactA?.downloads }))

  // Clicking 安装人数 asks the other direction and must return exactly the counted people.
  const installersA = await get(`/dsh-market/admin/installs/plugin?name=${encodeURIComponent(PLUGIN_A)}`, token)
  const installerNames = (installersA.body?.accounts ?? []).map((account) => account.username).sort()
  ok('点安装人数返回账号列表', installersA.body?.ok === true && installersA.body?.total === 2,
    JSON.stringify(installerNames))
  ok('  列表正好是 admin 和 alice', JSON.stringify(installerNames) === JSON.stringify(['admin', 'alice']),
    JSON.stringify(installerNames))
  ok('  每个账号带版本与设备数', (installersA.body?.accounts ?? []).every(
    (account) => account.versions.includes('1.0.0') && account.devices >= 1,
  ), JSON.stringify(installersA.body?.accounts))
  const badPluginName = await get('/dsh-market/admin/installs/plugin?name=..%2Fescape', token)
  ok('插件名非法 -> 400', badPluginName.status === 400 && badPluginName.body?.code === 'E_BAD_NAME',
    `${badPluginName.status}/${badPluginName.body?.code}`)

  // Both dialogs page server-side, so a long list cannot turn into one giant text node.
  const installersPage = await get(
    `/dsh-market/admin/installs/plugin?name=${encodeURIComponent(PLUGIN_A)}&limit=1&offset=0`, token,
  )
  ok('安装账号列表分页：total 与页大小分开返回', installersPage.body?.total === 2
    && installersPage.body?.accounts?.length === 1
    && installersPage.body?.limit === 1, JSON.stringify({
    total: installersPage.body?.total,
    entries: installersPage.body?.accounts?.length,
    limit: installersPage.body?.limit,
  }))
  const accountPage = await get('/dsh-market/admin/installs/account?username=admin&limit=1&offset=0', token)
  ok('账号插件列表也分页', accountPage.body?.items?.length === 1
    && accountPage.body?.total >= 2
    && accountPage.body?.limit === 1, JSON.stringify({
    total: accountPage.body?.total,
    entries: accountPage.body?.items?.length,
    limit: accountPage.body?.limit,
  }))
}

console.log('')
console.log('结论：')
console.log('  · 安装/卸载会自动上报；启动时用绑定密钥对账，不需要浏览器。')
console.log('  · 按账号：账号 → 已安装插件（跨设备合并），并报告设备数。')
console.log('  · 按插件：安装人数按账号去重，设备数单列，下载次数来自服务端审计。')
console.log('  · 一台设备一条快照：重复上报幂等，卸载/召回移除会真正减少计数。')
console.log('  · 身份只来自令牌；未知包名丢弃，非法输入拒绝。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
