/**
 * Recall: the service asking a machine to REMOVE what it already installed.
 *
 * This is the half that revocation never had. `state = revoked` stops distribution — the
 * catalog drops it and `/download` refuses — and deliberately leaves installed copies alone,
 * which is right for "pull it while I fix it". Recall is the security intent, and before this
 * the client had no awareness of it at all: `lib/plugin.js` did not contain the word.
 *
 * The properties worth pinning, because every one of them fails SILENTLY:
 *
 *   - a recalled artifact is actually removed from the profile
 *   - a recall names a VERSION, so a newer unrecalled copy is left alone
 *   - a recall that cannot be delivered (no credential, offline) removes nothing rather than
 *     guessing
 *   - every removal leaves a receipt, because files vanishing unexplained is a worse failure
 *     than the one recall solves
 *   - the kill switch works
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'
import { packTarGz } from '../server/lib/pack.js'

const work = mkdtempSync(join(tmpdir(), 'dsh-recall-'))
const profileDir = join(work, 'profile')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-recall', private: true,
  dsh: { profile: { bundles: ['dsh-plugin-marketplace'], disabledBundles: [] } },
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
process.env.MARKET_SERVICE_TOKEN = ''

const post = async (path, body, token) => {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const boot = (await post('/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })).body
await post('/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, boot.token)
const { token } = (await post('/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body
await post('/dsh-market/admin/groups', { id: 'platform', description: '平台' }, token)
await post('/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '*', effect: 'allow' }, token)
await post('/dsh-market/admin/membership', { username: 'admin', groupId: 'platform' }, token)

/** Publish a skill or a plugin directly through the store. */
const publish = (name, version, kind) => {
  const dir = join(work, `src-${name.replace(/[@/]/g, '_')}-${version}`)
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version, description: `${name} ${version}`,
    dsh: kind === 'skill' ? { market: { kind: 'skill' } } : { market: {} },
  }))
  if (kind === 'skill') writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name.split('/').pop()}\ndescription: 说明。\n---\n\n正文\n`)
  else {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'plugin.js'), 'export function apply() {}\n')
  }
  const entries = kind === 'skill'
    ? ['package.json', 'SKILL.md', 'references/notes.md']
    : ['package.json', 'lib/plugin.js']
  writeFileSync(join(dir, 'references', 'notes.md'), '# n\n')
  return app.artifacts.publishArchive(packTarGz(dir, entries), { publishedBy: 'tester', state: 'published' })
}

const SKILL = '@dsh-internal/recall-skill'
const PLUGIN = '@dsh-internal/recall-plugin'
/**
 * Only the versions that are CURRENT when they are installed.
 *
 * The catalog lists just the highest publishable version per name, so publishing 1.1.0 before
 * installing would make 1.0.0 unreachable — which is correct behaviour, not a limitation. The
 * probe therefore publishes 1.0.0, installs it, and only later publishes 1.1.0.
 */
publish(SKILL, '1.0.0', 'skill')
publish(PLUGIN, '1.0.0', 'plugin')

/** Drive the plugin's own install route, so the profile really holds the artifact. */
const { apply, reconcileRecalled } = await import('../lib/plugin.js')
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

/**
 * The default `Origin` is the port this harness registers, because the routes that write to the
 * profile are same-origin guarded and a real browser attaches `Origin` to every POST. A caller
 * that wants to prove the guard refuses a bare request passes `{ origin: null }` explicitly.
 */
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
  const catalog = await (await fetch(`${BASE}/dsh-market/catalog?limit=100`, { headers: { authorization: `Bearer ${token}` } })).json()
  const entry = catalog.entries.find((e) => e.name === name && e.version === version)
  if (entry === undefined) throw new Error(`not in catalog: ${name}@${version}`)
  return invoke('/dsh-market/install', {
    token, name, version, sha256: entry.sha256, channel: entry.channel,
  })
}
const skillDir = (name) => join(profileDir, '.dsh-market-skills', name.replace(/\//g, '__'))
const pluginDir = (name) => join(profileDir, 'node_modules', ...name.split('/'))
const RECEIPT = join(profileDir, '.dsh-market-recalled.json')
const receipt = () => {
  try { return JSON.parse(readFileSync(RECEIPT, 'utf8')).items ?? [] } catch { return [] }
}

console.log('--- 装好之后，服务端召回 ---')
{
  const installedSkill = await install(SKILL, '1.0.0')
  ok('技能安装成功', installedSkill.body?.ok === true, JSON.stringify(installedSkill.body).slice(0, 90))
  ok('  技能目录存在', existsSync(skillDir(SKILL)))
  const installedPlugin = await install(PLUGIN, '1.0.0')
  ok('插件安装成功', installedPlugin.body?.ok === true, JSON.stringify(installedPlugin.body).slice(0, 90))
  ok('  插件目录存在', existsSync(pluginDir(PLUGIN)))

  // Recall only the skill. The plugin must be left alone, which is the version/name precision.
  const recalled = await post('/dsh-market/admin/artifacts/recall',
    { name: SKILL, version: '1.0.0', channel: 'stable', recalled: true }, token)
  ok('召回接口接受请求', recalled.status === 200 && recalled.body?.ok === true, `${recalled.status}/${recalled.body?.code}`)

  process.env.MARKET_SERVICE_TOKEN = token
  const result = await reconcileRecalled()
  ok('对账执行并移除了东西', result.status === 'removed', JSON.stringify(result))
  ok('  技能目录被删除（技能即时生效）', !existsSync(skillDir(SKILL)))
  ok('  未召回的插件没有被牵连', existsSync(pluginDir(PLUGIN)))

  const items = receipt()
  ok('留下回执，说明移除了什么', items.some((entry) => entry.name === SKILL && entry.version === '1.0.0'),
    JSON.stringify(items))
  ok('  回执标明了类别', items.find((entry) => entry.name === SKILL)?.kind === 'skill',
    String(items.find((entry) => entry.name === SKILL)?.kind))
  /**
   * The receipt records a PAST removal, so lifting the recall must not erase it — the removal
   * still happened. It also must not linger implying a CURRENT state, which is what the page
   * did: it said 「服务端召回」 in the present tense and stayed there after the recall was
   * cancelled, with no way to clear it.
   *
   * So: un-recall keeps the record, and dismissing is an explicit act.
   */
  await post('/dsh-market/admin/artifacts/recall',
    { name: SKILL, version: '1.0.0', channel: 'stable', recalled: false }, token)
  const stillThere = await reconcileRecalled()
  ok('取消召回不会抹掉回执（移除确实发生过）',
    receipt().some((entry) => entry.name === SKILL), JSON.stringify(stillThere))
  ok('  而且不会把已移除的东西装回来', !existsSync(skillDir(SKILL)))
  // ...but the client's own inventory no longer reports it, so nothing is removed again.
  ok('  再次对账不会重复移除', stillThere.status === 'clean', JSON.stringify(stillThere))
}

console.log('')
console.log('--- 提示可以清掉（否则它会永远停在屏幕上）---')
{
  const forDismiss = await install(SKILL, '1.0.0')
  ok('先重新装上一个', forDismiss.body?.ok === true, JSON.stringify(forDismiss.body).slice(0, 70))
  await post('/dsh-market/admin/artifacts/recall',
    { name: SKILL, version: '1.0.0', channel: 'stable', recalled: true }, token)
  process.env.MARKET_SERVICE_TOKEN = token
  await reconcileRecalled()
  ok('有回执可清', receipt().length > 0, JSON.stringify(receipt().map((e) => e.name)))
  /**
   * The same artifact was removed more than once in this probe (installed, recalled, removed,
   * reinstalled, recalled, removed). The receipt must show it ONCE — it answers "what is gone",
   * not "how many times".
   */
  const keys = receipt().map((entry) => `${entry.name}@${entry.version}`)
  ok('同一项被移除多次只记一条',
    new Set(keys).size === keys.length, JSON.stringify(keys))

  // Without the page's origin the request must be refused: a foreign site cannot clear it.
  const foreign = await invoke('/dsh-market/recalled/dismiss', {}, { origin: 'http://evil.example' })
  ok('外部来源不能清掉提示', foreign.body?.code === 'E_FOREIGN_ORIGIN', JSON.stringify(foreign.body))
  ok('  回执仍在', receipt().length > 0)

  const own = await invoke('/dsh-market/recalled/dismiss', {}, { origin: `http://127.0.0.1:17901` })
  ok('市场页可以清掉它', own.body?.ok === true, JSON.stringify(own.body))
  ok('  文件已删除，重新加载后不再显示', receipt().length === 0 && !existsSync(RECEIPT))
  const readBack = await invoke('/dsh-market/recalled')
  ok('  接口也确认是空的', readBack.body?.count === 0, JSON.stringify(readBack.body))
  // Housekeeping for the later sections, which assume a clean-ish state.
  await post('/dsh-market/admin/artifacts/recall',
    { name: SKILL, version: '1.0.0', channel: 'stable', recalled: false }, token)
  const restore = await install(SKILL, '1.0.0')
  ok('  恢复现场', restore.body?.ok === true, JSON.stringify(restore.body).slice(0, 60))
}

console.log('')
console.log('--- 版本精确：召回 1.0.0 不动已装的 1.1.0 ---')
{
  // Published only now, so it is the version a client would have installed today.
  publish(SKILL, '1.1.0', 'skill')
  const newer = await install(SKILL, '1.1.0')
  ok('装上 1.1.0', newer.body?.ok === true, JSON.stringify(newer.body).slice(0, 80))
  ok('  本机现在是 1.1.0', existsSync(skillDir(SKILL)))
  // 1.0.0 is already recalled from the previous section; reconcile must not touch 1.1.0.
  const result = await reconcileRecalled()
  ok('对账不会因为名字相同就删除较新的版本', existsSync(skillDir(SKILL)), JSON.stringify(result))
  ok('  报告为无需处理', result.status === 'clean', String(result.status))
}

console.log('')
console.log('--- 召回取不到凭据时不猜 ---')
{
  const target = await install(PLUGIN, '1.0.0')
  ok('重新装回插件', target.body?.ok === true, JSON.stringify(target.body).slice(0, 80))
  await post('/dsh-market/admin/artifacts/recall',
    { name: PLUGIN, version: '1.0.0', channel: 'stable', recalled: true }, token)

  process.env.MARKET_SERVICE_TOKEN = ''
  const noCredential = await reconcileRecalled()
  ok('没有凭据时明确报告，而不是删东西', noCredential.status === 'no-credential', JSON.stringify(noCredential))
  ok('  插件原样保留', existsSync(pluginDir(PLUGIN)))
}

console.log('')
console.log('--- 开关可以关掉它 ---')
{
  process.env.MARKET_SERVICE_TOKEN = token
  process.env.MARKET_AUTO_RECALL = '0'
  const disabled = await reconcileRecalled()
  ok('MARKET_AUTO_RECALL=0 时不执行', disabled.status === 'disabled', JSON.stringify(disabled))
  ok('  插件仍然保留', existsSync(pluginDir(PLUGIN)))

  process.env.MARKET_AUTO_RECALL = ''
  const again = await reconcileRecalled()
  ok('打开后立刻生效：插件被移除', again.status === 'removed' && !existsSync(pluginDir(PLUGIN)),
    JSON.stringify(again))
  ok('  并提示需要重启（loader 只在启动时读）', again.needRestart === true, String(again.needRestart))
  ok('  回执里也有它', receipt().some((entry) => entry.name === PLUGIN), JSON.stringify(receipt().map((e) => e.name)))
}

console.log('')
console.log('--- 服务端：召回的制品不再可分发 ---')
{
  const catalog = await (await fetch(`${BASE}/dsh-market/catalog?limit=100`, { headers: { authorization: `Bearer ${token}` } })).json()
  ok('被召回的版本不在目录里', catalog.entries.every((e) => !(e.name === PLUGIN && e.version === '1.0.0')),
    JSON.stringify(catalog.entries.map((e) => `${e.name}@${e.version}`)))
  const download = await fetch(`${BASE}/dsh-market/download?name=${encodeURIComponent(PLUGIN)}&version=1.0.0`, {
    headers: { authorization: `Bearer ${token}` },
  })
  ok('  下载被拒（一个字节都不发）', download.status !== 200, String(download.status))
  const body = await download.json().catch(() => null)
  ok('  错误码是 E_RECALLED（与 E_REVOKED 区分）', body?.code === 'E_RECALLED', String(body?.code))
  // A recall must not be a substitute for revocation losing track: unrecall restores it.
  await post('/dsh-market/admin/artifacts/recall',
    { name: PLUGIN, version: '1.0.0', channel: 'stable', recalled: false }, token)
  const after = await fetch(`${BASE}/dsh-market/download?name=${encodeURIComponent(PLUGIN)}&version=1.0.0`, {
    headers: { authorization: `Bearer ${token}` },
  })
  ok('  取消召回后又能下载（它是可逆的）', after.status === 200, String(after.status))
}

console.log('')
console.log('--- installed-status：目录不肯回答的那个问题 ---')
{
  /**
   * The precondition is established HERE, not inherited from an earlier section.
   *
   * Relying on leftover state made this assertion fail once the section above started
   * un-recalling things to test dismissal — a test that depends on where it sits in the file is
   * a test that breaks for reasons unrelated to what it checks.
   */
  await post('/dsh-market/admin/artifacts/recall',
    { name: SKILL, version: '1.0.0', channel: 'stable', recalled: true }, token)
  await post('/dsh-market/admin/artifacts/recall',
    { name: PLUGIN, version: '1.0.0', channel: 'stable', recalled: false }, token)

  const answer = await post('/dsh-market/installed-status', {
    items: [
      { name: PLUGIN, version: '1.0.0', channel: 'stable' },
      { name: SKILL, version: '1.0.0', channel: 'stable' },
      { name: SKILL, version: '1.1.0', channel: 'stable' },
      { name: '@dsh-internal/never-published', version: '1.0.0', channel: 'stable' },
    ],
  }, token)
  const byKey = new Map((answer.body?.entries ?? []).map((e) => [`${e.name}@${e.version}`, e]))
  ok('按名字+版本逐条回答', byKey.size === 4, JSON.stringify([...byKey.keys()]))
  ok('  已取消召回的显示 recalled=false', byKey.get(`${PLUGIN}@1.0.0`)?.recalled === false)
  ok('  仍被召回的显示 recalled=true', byKey.get(`${SKILL}@1.0.0`)?.recalled === true)
  ok('  未召回的版本是 false', byKey.get(`${SKILL}@1.1.0`)?.recalled === false)
  ok('  服务端没有的制品 known=false', byKey.get('@dsh-internal/never-published@1.0.0')?.known === false)
  ok('  顺带报告可升级到的最高版本', byKey.get(`${SKILL}@1.0.0`)?.latest === '1.1.0',
    String(byKey.get(`${SKILL}@1.0.0`)?.latest))
}

console.log('')
console.log('--- 启动时会自动跑 ---')
{
  // `apply` schedules it; re-mounting is enough to observe that it is wired.
  process.env.MARKET_SERVICE_TOKEN = token
  mount()
  await new Promise((r) => setTimeout(r, 1200))
  const log = readFileSync(join(work, 'diag.log'), 'utf8')
  ok('挂载后会记录一次对账结果', /\[recall\] \{/.test(log), log.split('\n').filter((l) => l.includes('[recall]')).slice(-1)[0] ?? '(无)')
}

console.log('')
console.log('结论：')
console.log('  · 召回让客户端真的移除已安装的副本；撤回仍然只是停止分发。')
console.log('  · 按名字+版本精确匹配，所以召回 1.0.0 不会删掉已装的 1.1.0。')
console.log('  · 拿不到凭据时不猜、不删。')
console.log('  · 每次移除都留回执，页面据此告知用户。')
console.log('  · 服务端不再分发被召回的版本，错误码与 revoked 区分。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
