/**
 * The console must be able to see — and fix — an artifact it just revoked.
 *
 * Reported: revoking a plugin's state in the console made it vanish from the console, so it
 * could not be changed back. The cause was that the management list used `catalogRows()`, the
 * CLIENT catalog view, which drops every name whose versions are all non-publishable. That is
 * right for clients (a revoked artifact must never be offered) and exactly wrong for the only
 * screen that can un-revoke it.
 *
 * Drafts and review-only artifacts disappeared the same way — worse, because a draft could
 * never be promoted and a review could never be approved.
 *
 * The second half is the per-version reachability: the row shows one version, so with several
 * versions present the row's `versions` payload is what makes the others actionable.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-revoke-'))
let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${app.server.address().port}`

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

/** One package directory per version, so several versions of one name can coexist. */
const publish = (name, version, state) => {
  const dir = join(work, `src-${name.replace(/[@/]/g, '_')}-${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, description: `${name} ${version}` }))
  writeFileSync(join(dir, 'lib.js'), 'export function apply() {}\n')
  return app.artifacts.publishFromDirectory(dir, { publishedBy: 'tester', state })
}

const adminList = async () => {
  const response = await fetch(`${BASE}/dsh-market/admin/artifacts?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return (await response.json()).entries
}
const stateOf = (entries, name) => entries.find((entry) => entry.name === name)

console.log('--- 撤回唯一版本后，管理列表仍然看得见 ---')
{
  publish('@dsh-internal/only-one', '1.0.0', 'published')
  const before = stateOf(await adminList(), '@dsh-internal/only-one')
  ok('撤回前能看到', before !== undefined && before.status === 'published', String(before?.status))

  const changed = await post('/dsh-market/admin/artifacts/state',
    { name: '@dsh-internal/only-one', version: '1.0.0', channel: 'stable', state: 'revoked' }, token)
  ok('撤回成功', changed.status === 200 && changed.body?.ok === true, `${changed.status}/${changed.body?.code}`)

  /**
   * The bug. `catalogRows()` would drop this name entirely, because no version of it is
   * publishable any more.
   */
  const after = stateOf(await adminList(), '@dsh-internal/only-one')
  ok('撤回后管理列表里仍然在（这就是原 bug）', after !== undefined,
    JSON.stringify((await adminList()).map((e) => `${e.name}:${e.status}`)))
  ok('  并且状态如实显示为 revoked', after?.status === 'revoked', String(after?.status))

  // ...and the way back works, which is the whole point of still seeing it.
  const restored = await post('/dsh-market/admin/artifacts/state',
    { name: '@dsh-internal/only-one', version: '1.0.0', channel: 'stable', state: 'published' }, token)
  ok('可以改回 published', restored.status === 200 && restored.body?.ok === true, String(restored.body?.code))
  const back = stateOf(await adminList(), '@dsh-internal/only-one')
  ok('  改回后状态确实是 published', back?.status === 'published', String(back?.status))
}

console.log('')
console.log('--- 草稿与待审也不会消失（此前连提升都做不到）---')
{
  publish('@dsh-internal/draft-only', '1.0.0', 'draft')
  publish('@dsh-internal/review-only', '1.0.0', 'review')
  const entries = await adminList()
  ok('只有草稿的插件在管理列表里可见', stateOf(entries, '@dsh-internal/draft-only')?.status === 'draft',
    String(stateOf(entries, '@dsh-internal/draft-only')?.status))
  ok('只有待审的插件也在', stateOf(entries, '@dsh-internal/review-only')?.status === 'review',
    String(stateOf(entries, '@dsh-internal/review-only')?.status))
  /**
   * A SEPARATE package, because promoting the draft above would change a fact the next
   * section relies on — it asserts that a non-publishable artifact stays out of the CLIENT
   * catalog, and `draft-only` would no longer be one.
   */
  publish('@dsh-internal/promote-me', '1.0.0', 'draft')
  const promoted = await post('/dsh-market/admin/artifacts/state',
    { name: '@dsh-internal/promote-me', version: '1.0.0', channel: 'stable', state: 'published' }, token)
  ok('  草稿可以被提升为已发布', promoted.body?.ok === true, String(promoted.body?.code))
  ok('    提升后状态确实是 published', stateOf(await adminList(), '@dsh-internal/promote-me')?.status === 'published',
    String(stateOf(await adminList(), '@dsh-internal/promote-me')?.status))
}

console.log('')
console.log('--- 客户端目录仍然不显示非 published 的版本（这条不能被改坏）---')
{
  publish('@dsh-internal/mixed', '1.0.0', 'revoked')
  publish('@dsh-internal/mixed', '1.1.0', 'published')
  const catalog = await fetch(`${BASE}/dsh-market/catalog?limit=100`, { headers: { authorization: `Bearer ${token}` } })
  const entries = (await catalog.json()).entries
  const mixed = entries.find((entry) => entry.name === '@dsh-internal/mixed')
  ok('目录里只出现可发布的那个版本', mixed?.version === '1.1.0', String(mixed?.version))
  ok('  完全不可发布的插件不进目录', entries.every((e) => e.name !== '@dsh-internal/draft-only'),
    JSON.stringify(entries.filter((e) => e.name.includes('draft')).map((e) => e.name)))
  // The management row still sees the revoked lower version, which is how it gets fixed.
  const row = stateOf(await adminList(), '@dsh-internal/mixed')
  ok('管理行带出该名字的全部版本', (row?.versions ?? []).length === 2,
    JSON.stringify(row?.versions))
  ok('  其中一个就是被撤回的 1.0.0',
    (row?.versions ?? []).some((v) => v.version === '1.0.0' && v.status === 'revoked'),
    JSON.stringify(row?.versions))
  ok('  最高版本（行本身）是可发布的 1.1.0', row?.version === '1.1.0' && row?.status === 'published',
    `${row?.version}/${row?.status}`)

  // And the lower, revoked version is reachable — the state route takes an explicit version.
  const revived = await post('/dsh-market/admin/artifacts/state',
    { name: '@dsh-internal/mixed', version: '1.0.0', channel: 'stable', state: 'published' }, token)
  ok('可以单独把被撤回的 1.0.0 改回来', revived.body?.ok === true, String(revived.body?.code))
  const after = stateOf(await adminList(), '@dsh-internal/mixed')
  ok('  改回后该版本的 status 也更新了',
    (after?.versions ?? []).some((v) => v.version === '1.0.0' && v.status === 'published'),
    JSON.stringify(after?.versions))
}

console.log('')
console.log('--- 排序与分页不受影响 ---')
{
  const entries = await adminList()
  const names = entries.map((entry) => entry.name)
  ok('仍按名字排序', JSON.stringify(names) === JSON.stringify([...names].sort()), JSON.stringify(names))
  const paged = await fetch(`${BASE}/dsh-market/admin/artifacts?limit=2&offset=0`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = await paged.json()
  ok('分页仍生效且 total 是全量', body.entries.length === 2 && body.total === entries.length,
    `${body.entries.length} / ${body.total}`)
  ok('  检索仍生效', (await fetch(`${BASE}/dsh-market/admin/artifacts?q=only-one`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())).total === 1)
  /**
   * Filtering by state has to work too: the search read `artifact.state`, which is undefined,
   * so searching for a state matched nothing at all.
   *
   * `review`, not `revoked` — by this point the probe has deliberately un-revoked everything it
   * revoked, so no artifact is in that state and `total=0` would be correct rather than a bug.
   */
  const byState = await fetch(`${BASE}/dsh-market/admin/artifacts?q=review&limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())
  ok('  可以按状态检索（此前读错字段，永远搜不到）',
    byState.total === 1 && byState.entries[0]?.status === 'review', `total=${byState.total}`)
}

console.log('')
console.log('--- 字段名：接口给的是 status，不是 state ---')
/**
 * `rowToArtifact` publishes the DB's `state` column under the name `status` — the same name the
 * client catalog uses. The console read `artifact.state`, which is `undefined`, and the damage
 * was not cosmetic: the 改状态 select had no matching option, so the browser preselected the
 * FIRST one (`draft`), and saving without touching it silently demoted a published artifact.
 *
 * Asserted on the payload so a rename in either direction is caught here.
 */
{
  const entries = await adminList()
  ok('条目带 status 字段', entries.every((entry) => typeof entry.status === 'string' && entry.status !== ''),
    JSON.stringify(entries.map((e) => `${e.name}:${e.status}`)))
  ok('  条目不带 state 字段（避免两个名字并存）',
    entries.every((entry) => entry.state === undefined),
    JSON.stringify(entries.filter((e) => e.state !== undefined).map((e) => e.name)))
  const withVersions = entries.find((entry) => Array.isArray(entry.versions) && entry.versions.length > 0)
  ok('  每个版本也用 status 报告状态',
    withVersions !== undefined && withVersions.versions.every((v) => typeof v.status === 'string'),
    JSON.stringify(withVersions?.versions))
}

console.log('')
console.log('结论：')
console.log('  · 管理列表用 adminRows()（忽略状态），客户端目录用 catalogRows()（只要可发布的）。')
console.log('  · 撤回后仍能在控制台看到并改回；草稿也能被提升。')
console.log('  · 该名字的全部版本随行返回，所以非最高版本也能单独改状态。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
