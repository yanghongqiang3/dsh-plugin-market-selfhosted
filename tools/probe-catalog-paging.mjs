/**
 * The client catalog: tab filtering and server-side paging.
 *
 * The install page offers 全部 / 插件 / 技能. Two tabs over THREE stored kinds — a bundle is a
 * plugin package that also carries a patch layer, and to someone installing it the difference
 * from a plain plugin is invisible, so `plugin` must cover both.
 *
 * The reason paging forced the filter to move to the service: while the whole catalog arrived
 * in one response, filtering in the browser was the same thing. With pages, a browser-side
 * filter searches only the page on screen and reports "no match" for entries that are simply
 * on another page.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-catalog-'))
let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${app.server.address().port}`

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

/** Publish a package of a given kind. */
const publish = (name, kind, extra = {}) => {
  const dir = mkdtempSync(join(work, 'src-'))
  const dsh = kind === 'skill'
    ? { market: { kind: 'skill', owner: 'platform', summary: `${name} 的摘要` } }
    : kind === 'bundle'
      ? { bundle: { patch: 'cordis.patch.yml' } }
      : { market: { owner: 'platform', summary: `${name} 的摘要` } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh }))
  if (kind === 'skill') writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${extra.skillName ?? name.split('/').pop()}\ndescription: 说明。\n---\n\n正文\n`)
  if (kind === 'bundle') writeFileSync(join(dir, 'cordis.patch.yml'), '- name: x\n')
  if (kind !== 'skill') {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'plugin.js'), 'export function apply() {}\n')
  }
  return app.artifacts.publishFromDirectory(dir, { publishedBy: 'alice', state: 'published' })
}

// 25 packages: 15 plugins, 4 bundles, 6 skills. Enough to exercise more than one page.
for (let i = 1; i <= 15; i += 1) publish(`@dsh-internal/plugin-${String(i).padStart(2, '0')}`, 'plugin')
for (let i = 1; i <= 4; i += 1) publish(`@dsh-internal/bundle-${String(i).padStart(2, '0')}`, 'bundle')
for (let i = 1; i <= 6; i += 1) publish(`@dsh-internal/skill-${String(i).padStart(2, '0')}`, 'skill')

const catalog = (query, token = alice) => call('GET', `/dsh-market/catalog${query}`, undefined, token)

console.log('--- tab 计数来自服务端（标签不会与筛选行为脱节）---')
{
  const all = await catalog('')
  ok('默认返回全部', all.body?.total === 25, String(all.body?.total))
  ok('counts.all = 25', all.body?.counts?.all === 25, String(all.body?.counts?.all))
  ok('counts.skill = 6', all.body?.counts?.skill === 6, String(all.body?.counts?.skill))
  // 15 plugins + 4 bundles: a bundle installs like a plugin, so it belongs to that tab.
  ok('counts.plugin = 19（含组合包）', all.body?.counts?.plugin === 19, String(all.body?.counts?.plugin))
  ok('  两个桶加起来就是全部', all.body.counts.plugin + all.body.counts.skill === all.body.counts.all,
    `${all.body.counts.plugin}+${all.body.counts.skill} vs ${all.body.counts.all}`)
}

console.log('')
console.log('--- 按 kind 筛选 ---')
{
  const skills = await catalog('?kind=skill&limit=50')
  ok('kind=skill 只给技能', skills.body?.total === 6 && skills.body.entries.every((e) => e.kind === 'skill'),
    `${skills.body?.total}`)
  const plugins = await catalog('?kind=plugin&limit=50')
  ok('kind=plugin 含插件与组合包', plugins.body?.total === 19, String(plugins.body?.total))
  const kinds = new Set(plugins.body.entries.map((e) => e.kind))
  ok('  确实包含 bundle', kinds.has('bundle') && kinds.has('plugin'), JSON.stringify([...kinds]))
  const nonsense = await catalog('?kind=nonsense')
  ok('无法识别的 kind 退回全部', nonsense.body?.total === 25 && nonsense.body?.kind === 'all',
    `${nonsense.body?.kind}/${nonsense.body?.total}`)
  ok('  对外的 kind 字段是规范化后的值', nonsense.body?.kind === 'all', String(nonsense.body?.kind))
}

console.log('')
console.log('--- 服务端分页 ---')
{
  const first = await catalog('?limit=10&offset=0')
  ok('每页 10 条', first.body?.entries?.length === 10, String(first.body?.entries?.length))
  ok('  total 是筛选后的总数，不是本页条数', first.body?.total === 25, String(first.body?.total))
  const second = await catalog('?limit=10&offset=10')
  const overlap = first.body.entries.filter((a) => second.body.entries.some((b) => b.name === a.name))
  ok('第二页与第一页不重叠', overlap.length === 0, JSON.stringify(overlap.map((e) => e.name)))
  const third = await catalog('?limit=10&offset=20')
  ok('最后一页只剩余数', third.body?.entries?.length === 5, String(third.body?.entries?.length))
  const beyond = await catalog('?limit=10&offset=100')
  ok('offset 超出返回空页而不是错误', beyond.status === 200 && beyond.body.entries.length === 0 && beyond.body.total === 25,
    `${beyond.status}/${beyond.body?.entries?.length}`)
  const bad = await catalog('?limit=abc&offset=-5')
  ok('非法分页参数退回默认', bad.status === 200 && bad.body.limit === 20 && bad.body.offset === 0,
    `${bad.body?.limit}/${bad.body?.offset}`)
  const huge = await catalog('?limit=9999')
  ok('limit 被钳到上限', huge.body?.limit <= 200 && huge.body.limit > 0, String(huge.body?.limit))
}

console.log('')
console.log('--- 筛选与分页一起生效 ---')
{
  const page = await catalog('?kind=skill&limit=4&offset=0')
  ok('技能桶分页：total 是该桶总数', page.body?.total === 6, String(page.body?.total))
  ok('  本页全是技能', page.body.entries.length === 4 && page.body.entries.every((e) => e.kind === 'skill'))
  const page2 = await catalog('?kind=skill&limit=4&offset=4')
  ok('  第二页只剩 2 条', page2.body?.entries?.length === 2, String(page2.body?.entries?.length))
  ok('  counts 不随分页变化', page2.body?.counts?.all === 25 && page2.body?.counts?.skill === 6,
    JSON.stringify(page2.body?.counts))
}

console.log('')
console.log('--- 搜索在服务端做（否则只搜当前页）---')
{
  const hit = await catalog('?q=skill-03')
  ok('搜索命中', hit.body?.total === 1 && hit.body.entries[0].name === '@dsh-internal/skill-03',
    JSON.stringify(hit.body?.entries?.map((e) => e.name)))
  /**
   * The decisive one: an entry that lives on a LATER page must still be found. A browser-side
   * filter over page 1 would report nothing.
   */
  const late = await catalog('?limit=5&offset=0&q=plugin-14')
  ok('能搜到不在第一页的条目', late.body?.total === 1 && late.body.entries[0]?.name === '@dsh-internal/plugin-14',
    `${late.body?.total}/${JSON.stringify(late.body?.entries?.map((e) => e.name))}`)
  const none = await catalog('?q=zzz-nothing')
  ok('无匹配时 total=0 且不是错误', none.status === 200 && none.body.total === 0, `${none.status}/${none.body?.total}`)
  ok('  counts 仍然报告各个 tab 的总量', none.body?.counts?.all === 25, JSON.stringify(none.body?.counts))
  const scoped = await catalog('?kind=skill&q=plugin')
  ok('搜索与 tab 同时生效', scoped.body?.total === 0, String(scoped.body?.total))
}

console.log('')
console.log('--- 目录显示全部并标注权限（既定的、有测试守着的设计）---')
{
  /**
   * I first wrote this section asserting that an unauthorized user sees NOTHING — because the
   * install page's own note claims "只显示你的权限组被授权的条目". That was wrong, and the
   * code was right: `test-server.mjs` and `probe-grant-flow.mjs` both assert that the catalog
   * deliberately SHOWS an entry with `canInstall: false` and a reason, since a user has to be
   * able to see that something exists in order to ask for access. Publishing grants nobody
   * anything; only a group rule does.
   *
   * So these assertions pin the real contract. The page's wording was the defect, and it is
   * fixed in the page rather than worked around here.
   */
  await call('POST', '/dsh-market/admin/users', { username: 'bob', password: 'bob-initial-2026' }, admin)
  const bobFirst = await call('POST', '/dsh-market/auth/login', { username: 'bob', password: 'bob-initial-2026' })
  await call('POST', '/dsh-market/auth/password', { newPassword: 'bob-password-2026' }, bobFirst.body.token)
  const bob = (await call('POST', '/dsh-market/auth/login', { username: 'bob', password: 'bob-password-2026' })).body.token
  const bobCatalog = await catalog('?limit=50', bob)
  ok('没有权限的用户仍能看到条目（否则无从申请权限）', bobCatalog.body?.total === 25, String(bobCatalog.body?.total))
  ok('  但每一条都 canInstall=false', bobCatalog.body.entries.every((e) => e.canInstall === false),
    JSON.stringify(bobCatalog.body.entries.filter((e) => e.canInstall).map((e) => e.name)))
  ok('  并给出原因，不是空白', bobCatalog.body.entries.every((e) => typeof e.reason === 'string' && e.reason !== ''),
    JSON.stringify([...new Set(bobCatalog.body.entries.map((e) => e.reason))]))
  // Counts describe what the list SHOWS, which is the same set the tabs paginate over.
  ok('  counts 与可见条目一致', bobCatalog.body?.counts?.all === bobCatalog.body.total,
    `${bobCatalog.body?.counts?.all} vs ${bobCatalog.body?.total}`)
  // And the permission verdict is per-entry, so an authorized user sees a different answer.
  const aliceSees = await catalog('?limit=50')
  ok('  有权限的用户看到 canInstall=true', aliceSees.body.entries.every((e) => e.canInstall === true),
    JSON.stringify(aliceSees.body.entries.filter((e) => !e.canInstall).map((e) => `${e.name}:${e.reason}`)))
  ok('  两个人的条目集合相同，只有判定不同',
    aliceSees.body.total === bobCatalog.body.total, `${aliceSees.body.total} vs ${bobCatalog.body.total}`)
}

console.log('')
console.log('结论：')
console.log('  · 两个 tab 覆盖三种存储类型：组合包归入「插件」，因为安装方式相同。')
console.log('  · 计数来自服务端，标签不会与实际筛选行为脱节。')
console.log('  · 搜索在服务端执行 —— 否则分页之后只能搜到当前页。')
console.log('  · 目录列出全部条目并逐条标注能否安装（既定的设计），没有权限不是「看不见」。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
