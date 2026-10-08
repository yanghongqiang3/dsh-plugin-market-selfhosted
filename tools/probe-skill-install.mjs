/**
 * Installing a SKILL through the market.
 *
 * Skills are not mounted by the loader, so the whole feature is: write the files into the
 * market's own directory, and register them with `ctx.skills` at start. This drives the
 * real install route and the real registry, and checks the properties that make it safe:
 *
 *   - the market writes ONLY its own directory (never `~/.dsh/skills`, which holds the
 *     operator's hand-written skills)
 *   - a skill with no `SKILL.md`, or a bad name, is REFUSED rather than half-installed
 *   - it appears in the installed list, so the page stops offering 安装
 *   - it reaches the registry, with the frontmatter's invocation flags honoured
 *   - uninstall removes the directory and leaves no trace
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createApp } from '../server/index.mjs'
import { packTarGz } from '../server/lib/pack.js'

const work = mkdtempSync(join(tmpdir(), 'dsh-skill-'))
const profileDir = join(work, 'profile')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-skills', private: true,
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

const call = async (method, path, body, token) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const adminLogin = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, adminLogin.body.token)
const admin = (await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body.token
await call('POST', '/dsh-market/admin/users', { username: 'alice', password: 'alice-initial-2026' }, admin)
const first = await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-initial-2026' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'alice-password-2026' }, first.body.token)
const alice = (await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-password-2026' })).body.token
await call('POST', '/dsh-market/admin/groups', { id: 'platform', description: '平台' }, admin)
await call('POST', '/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '@dsh-internal/*', effect: 'allow' }, admin)
await call('POST', '/dsh-market/admin/membership', { username: 'alice', groupId: 'platform' }, admin)

/** Publish a skill bundle: a minimal package.json (market metadata) + SKILL.md. */
const publishSkill = (name, { frontmatter = null, extra = {}, version = '1.0.0' } = {}) => {
  const dir = join(work, `src-${name}-${version}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version, dsh: { market: { kind: 'skill', owner: 'platform', summary: `技能 ${name}` } },
  }))
  if (frontmatter !== null) writeFileSync(join(dir, 'SKILL.md'), frontmatter)
  writeFileSync(join(dir, 'references', 'notes.md'), '# notes\n')
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const entries = ['package.json', 'references/notes.md', ...Object.keys(extra)]
  if (frontmatter !== null) entries.push('SKILL.md')
  return app.artifacts.publishArchive(packTarGz(dir, entries), { publishedBy: 'alice', state: 'published' })
}

const GOOD = '---\nname: release-checklist\ndescription: 发布前的检查清单。\nwhenToUse: 准备发布时\n---\n\n步骤一：确认版本号。\n'
publishSkill('@dsh-internal/skill-release-checklist', { frontmatter: GOOD })
publishSkill('@dsh-internal/skill-bad-name', {
  frontmatter: '---\nname: Not_Kebab_Case\ndescription: 名字非法。\n---\n\nbody\n',
})
// No SKILL.md at all. The archive is still a valid PACKAGE (it has package.json), so it
// reaches the install route, where the skill check has to refuse it.
publishSkill('@dsh-internal/skill-no-file', {})

// ------------------------------------------------------------------ the plugin
const { apply } = await import('../lib/plugin.js')
const routes = []
/**
 * A stand-in for `ctx.skills`.
 *
 * It reproduces the two behaviours that actually bit me:
 *
 *  1. a name is FIRST-WINS, and the returned disposer removes it. Without that fidelity the
 *     live-sync logic (dispose-before-register) could not be tested at all.
 *  2. `register()` is NOT the only validation. Loading goes through `validateDefinition`,
 *     which additionally demands that `source` and `provider` be strings. A registry stub
 *     that only checked what `register()` checks passed while the REAL registry refused to
 *     load the skill ("source must be a string") — so this stub validates both rules.
 */
const skillCatalog = new Map()
const registered = []
const RUNTIME_PROVIDER = 'runtime'
const fakeSkills = {
  /** Mirrors the registry's own `validateRuntimeSkill`. */
  validateRuntimeSkill(skill) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`)
    if (typeof skill.description !== 'string' || skill.description.length === 0) {
      throw new Error(`skill "${skill.name}" requires a description`)
    }
  },
  /** Mirrors `validateDefinition`, which is what a LOAD goes through. */
  validateDefinition(skill) {
    for (const field of ['name', 'description', 'source', 'provider', 'content']) {
      if (typeof skill[field] !== 'string') {
        throw new TypeError(`loaded skill "${skill.name}" ${field} must be a string`)
      }
    }
    if (skill.whenToUse !== undefined && typeof skill.whenToUse !== 'string') {
      throw new TypeError(`loaded skill "${skill.name}" whenToUse must be a string`)
    }
    if (skill.path !== undefined && typeof skill.path !== 'string') {
      throw new TypeError(`loaded skill "${skill.name}" path must be a string`)
    }
  },
  register(skill) {
    this.validateRuntimeSkill(skill)
    if (skillCatalog.has(skill.name)) {
      // Mirrors the registry: a duplicate is ignored, not replaced.
      return () => {}
    }
    // The registry fills `provider` in. Loading the DEFINITION then re-validates it, which
    // is exactly where a missing `source` surfaced.
    const definition = { ...skill, provider: skill.provider ?? RUNTIME_PROVIDER }
    this.validateDefinition(definition)
    skillCatalog.set(skill.name, definition)
    registered.push(definition)
    return () => { skillCatalog.delete(skill.name) }
  },
}
apply({
  get: (name) => {
    if (name === 'webServer') return { port: 17801, register: (route) => { routes.push(route); return () => {} } }
    if (name === 'skills') return fakeSkills
    return undefined
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
})
for (let i = 0; i < 60 && routes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50))
const route = (path) => routes.find((r) => String(r.path) === path)

const invoke = async (path, body) => {
  let captured = null
  const listeners = new Map()
  const req = {
    method: 'POST', url: path, headers: { 'content-type': 'application/json' },
    on: (event, cb) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return req },
    destroy: () => {},
  }
  const emit = (event, arg) => { for (const cb of listeners.get(event) ?? []) cb(arg) }
  setImmediate(() => { if (body !== undefined) emit('data', Buffer.from(JSON.stringify(body))); emit('end') })
  await route(path).handler(req, { writeHead: () => {}, end: (out) => { captured = out } })
  try { return { status: 200, body: JSON.parse(String(captured)) } } catch { return { status: 0, body: null } }
}
const getInstalled = async () => {
  let captured = null
  await route('/dsh-market/installed').handler(
    { method: 'GET', url: '/dsh-market/installed', headers: {} },
    { writeHead: () => {}, end: (out) => { captured = out } },
  )
  return JSON.parse(String(captured))
}

const catalog = await call('GET', '/dsh-market/catalog', undefined, alice)
const entry = (suffix) => catalog.body.entries.find((e) => e.name.endsWith(suffix))

console.log('--- 安装 ---')
const skillsRoot = join(profileDir, '.dsh-market-skills')
// Mirrors the plugin's skillDirName(): a scoped package flattens to one directory level.
const skillDirForName = (name) => join(skillsRoot, name.replace(/\//g, '__'))
const installed = await invoke('/dsh-market/install', {
  token: alice, name: entry('skill-release-checklist').name,
  version: entry('skill-release-checklist').version,
  sha256: entry('skill-release-checklist').sha256,
  channel: entry('skill-release-checklist').channel,
})
ok('技能安装成功', installed.body?.ok === true, JSON.stringify(installed.body).slice(0, 140))
ok('  报告 kind=skill（不是 plugin/bundle）', installed.body?.kind === 'skill', String(installed.body?.kind))
ok('  说明注册方式', String(installed.body?.registeredIn).includes('.dsh-market-skills'), String(installed.body?.registeredIn))
// Skills have no loader row, so nothing has to be picked up at boot.
ok('  明确报告不需要重启', installed.body?.needRestart === false, String(installed.body?.needRestart))
const skillDir = skillDirForName(entry('skill-release-checklist').name)
ok('  落到市场自己的目录', existsSync(skillDir), skillDir)
ok('  SKILL.md 在位', existsSync(join(skillDir, 'SKILL.md')))
ok('  子目录资源也在（references/）', existsSync(join(skillDir, 'references', 'notes.md')))

console.log('')
console.log('--- 不碰别人的 skill 根 ---')
/**
 * The property that motivated the whole design: the operator's own skills live in
 * `~/.dsh/skills`, and the market must never write there — or a later uninstall could
 * delete something a person wrote by hand.
 */
// DSH_HOME points at this run's scratch dir, so the operator skill root is work/skills.
// Asserting on that is meaningful; asserting on the real home is not.
ok('  没有写 DSH_HOME 下的 skills 根', !existsSync(join(work, 'skills')))
ok('  没有往 profile 的 cordis.patch.yml 写行', readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').trim() === '')
const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
ok('  没有写 dsh.profile.bundles', !profile.dsh.profile.bundles.includes(entry('skill-release-checklist').name))
ok('  没有加 file: 依赖', profile.dependencies === undefined || profile.dependencies[entry('skill-release-checklist').name] === undefined)

console.log('')
console.log('--- 技能与插件走同一套权限（不能因为它是 skill 就绕过）---')
/**
 * The skill branch lives inside `installEntry`, which fetches the bytes from the service
 * FIRST with the caller's token. Authorization is the service's answer to that download, so
 * a branch placed before it would have been a hole. Asserted, not assumed: a user with no
 * grants must be refused.
 */
await call('POST', '/dsh-market/admin/users', { username: 'bob', password: 'bob-initial-2026' }, admin)
const bobFirst = await call('POST', '/dsh-market/auth/login', { username: 'bob', password: 'bob-initial-2026' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'bob-password-2026' }, bobFirst.body.token)
const bob = (await call('POST', '/dsh-market/auth/login', { username: 'bob', password: 'bob-password-2026' })).body.token
const skillEntry = entry('skill-release-checklist')
const denied = await invoke('/dsh-market/install', {
  token: bob, name: skillEntry.name, version: skillEntry.version,
  sha256: skillEntry.sha256, channel: skillEntry.channel,
})
ok('没有授权的用户装不了技能', denied.body?.ok === false, JSON.stringify(denied.body).slice(0, 110))
ok('  拒绝原因来自服务端（不是本地放行）', typeof denied.body?.code === 'string' && denied.body.code !== '', String(denied.body?.code))
const afterDenial = await getInstalled()
ok('  这次拒绝不影响别人已装的东西', afterDenial.entries.filter((e) => e.kind === 'skill').length === 1,
  JSON.stringify(afterDenial.entries.map((e) => `${e.kind}:${e.name}`)))

console.log('')
console.log('--- 非法技能被拒（不是半装）---')
const noFile = await invoke('/dsh-market/install', {
  token: alice, name: entry('skill-no-file').name, version: entry('skill-no-file').version,
  sha256: entry('skill-no-file').sha256, channel: entry('skill-no-file').channel,
})
ok('没有 SKILL.md 时拒绝安装', noFile.body?.ok === false, `${noFile.body?.code}`)
ok('  且没有留下目录', !existsSync(skillDirForName(entry('skill-no-file').name)))
const badName = await invoke('/dsh-market/install', {
  token: alice, name: entry('skill-bad-name').name, version: entry('skill-bad-name').version,
  sha256: entry('skill-bad-name').sha256, channel: entry('skill-bad-name').channel,
})
ok('非法 kebab-case 名称被拒', badName.body?.code === 'E_SKILL_BAD_NAME', String(badName.body?.code))
ok('  且没有留下目录', !existsSync(skillDirForName(entry('skill-bad-name').name)))

console.log('')
console.log('--- 已装列表要认得它 ---')
const list = await getInstalled()
const listed = list.entries.find((e) => e.name === entry('skill-release-checklist').name)
ok('已装列表包含该技能', listed !== undefined, JSON.stringify(list.entries.map((e) => `${e.name}:${e.kind}`)))
ok('  并标明 kind=skill', listed?.kind === 'skill', String(listed?.kind))
ok('  且带上技能在目录里的名字', listed?.skillName === 'release-checklist', String(listed?.skillName))

console.log('')
console.log('--- 注册进 ctx.skills ---')
// A fresh mount, which is when registration happens.
registered.length = 0
const routes2 = []
apply({
  get: (name) => {
    if (name === 'webServer') return { port: 17802, register: (r) => { routes2.push(r); return () => {} } }
    if (name === 'skills') return fakeSkills
    return undefined
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
})
for (let i = 0; i < 40 && routes2.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50))
ok('启动时注册了技能', registered.length === 1, JSON.stringify(registered.map((s) => s.name)))
const skill = registered[0] ?? {}
ok('  目录名取自 frontmatter', skill.name === 'release-checklist', String(skill.name))
ok('  带 description', typeof skill.description === 'string' && skill.description.length > 0)
ok('  带正文', String(skill.content).includes('步骤一'), JSON.stringify(String(skill.content).slice(0, 30)))
ok('  带 whenToUse', skill.whenToUse === '准备发布时', String(skill.whenToUse))
ok('  带 path（供文件预览）', String(skill.path).endsWith('SKILL.md'), String(skill.path))
ok('  默认两个接口都可调用', skill.invocation?.modelInvocable === true && skill.invocation?.userInvocable === true, JSON.stringify(skill.invocation))
// LOAD-time validation requires a string `source`; without it the skill LISTS and is found
// by name, then fails to load. That is the bug this stub now catches.
ok('  带 source（否则列得出来、加载不了）', typeof skill.source === 'string' && skill.source.length > 0, String(skill.source))
ok('  provider 由注册表补成 runtime', skill.provider === 'runtime', String(skill.provider))
ok('  假注册表的校验规则能拒绝缺 source 的定义', (() => {
  try {
    // Same call the plugin makes, minus source: must throw, or this stub is too lenient.
    fakeSkills.validateDefinition({ name: 'x', description: 'd', provider: 'runtime', content: 'c' })
    return false
  } catch { return true }
})())

console.log('')
console.log('--- 卸载 ---')
const removed = await invoke('/dsh-market/uninstall', { name: entry('skill-release-checklist').name })
ok('卸载成功', removed.body?.ok === true, JSON.stringify(removed.body))
ok('  目录被删除', !existsSync(skillDir))
ok('  空容器也清掉了', !existsSync(skillsRoot), String(existsSync(skillsRoot)))
const afterList = await getInstalled()
ok('  已装列表不再包含它', afterList.entries.every((e) => e.kind !== 'skill'), JSON.stringify(afterList.entries.map((e) => e.kind)))

console.log('')
console.log('--- 装完即时生效（不必重启）---')
/**
 * The first version only registered at mount, so a skill installed while DSH was running
 * stayed invisible until a restart. The filesystem provider refreshes live, so users would
 * have had to know which kind of artifact they installed to guess whether to restart.
 */
const fresh = await invoke('/dsh-market/install', {
  token: alice, name: entry('skill-release-checklist').name,
  version: entry('skill-release-checklist').version,
  sha256: entry('skill-release-checklist').sha256,
  channel: entry('skill-release-checklist').channel,
})
ok('重新安装技能', fresh.body?.ok === true, JSON.stringify(fresh.body).slice(0, 80))
// The poller runs every 2s; give it room without assuming an exact tick.
let appeared = false
for (let i = 0; i < 40 && !appeared; i += 1) {
  await new Promise((r) => setTimeout(r, 250))
  appeared = skillCatalog.has('release-checklist')
}
ok('  无需重启就进入目录', appeared, JSON.stringify([...skillCatalog.keys()]))

// Editing the body must REPLACE the entry. register() is first-wins, so a sync that did
// not dispose first would leave the stale text in place and look like it had worked.
writeFileSync(join(skillDirForName(entry('skill-release-checklist').name), 'SKILL.md'),
  '---\nname: release-checklist\ndescription: 改过的说明。\n---\n\n新正文。\n')
let updated = false
for (let i = 0; i < 40 && !updated; i += 1) {
  await new Promise((r) => setTimeout(r, 250))
  updated = String(skillCatalog.get('release-checklist')?.content ?? '').includes('新正文')
}
ok('  改了正文会替换（不是留着旧的）', updated, JSON.stringify(String(skillCatalog.get('release-checklist')?.content ?? '').slice(0, 20)))

await invoke('/dsh-market/uninstall', { name: entry('skill-release-checklist').name })
let gone = false
for (let i = 0; i < 40 && !gone; i += 1) {
  await new Promise((r) => setTimeout(r, 250))
  gone = !skillCatalog.has('release-checklist')
}
ok('  卸载后即时移出目录', gone, JSON.stringify([...skillCatalog.keys()]))

console.log('')
console.log('结论：')
console.log('  · 技能不进 loader：没有 patch 行、没有 bundles 条目、没有 file: 依赖。')
console.log('  · 只写市场自己的目录 <profile>/.dsh-market-skills，不碰 ~/.dsh/skills。')
console.log('  · 缺 SKILL.md 或名字非法一律拒绝，不留半装目录。')
console.log('  · 启动时经 ctx.skills.register 进入会话目录，之后轮询同步——装完即时生效。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
