/**
 * How does a published artifact become installable by a group?
 *
 * The question: should the console's publish form ask for a permission group?
 *
 * Answering it means measuring the actual chain — publish, then grant, then catalog —
 * rather than reasoning about the docs. Specifically: does publishing give anyone
 * access, and does a group need a rule mentioning THAT plugin, or does a pattern rule
 * covering it suffice?
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-grantflow-'))
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

const adminLogin = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, adminLogin.body.token)
const admin = (await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body.token

// A member in NO group, and a group with no rules.
await call('POST', '/dsh-market/admin/users', { username: 'alice', password: 'alice-initial-2026' }, admin)
const first = await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-initial-2026' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'alice-password-2026' }, first.body.token)
const alice = (await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-password-2026' })).body.token

// Publish an artifact with a distinctive name, straight through the store (the HTTP
// upload path is covered elsewhere; this is about the GRANT chain).
const pluginsDir = join(workDir, 'plugins')
mkdirSync(join(pluginsDir, 'pkg-billing'), { recursive: true })
writeFileSync(
  join(pluginsDir, 'pkg-billing', 'package.json'),
  JSON.stringify({ name: '@dsh-internal/dsh-plugin-billing', version: '1.0.0' }),
)
const published = app.artifacts.publishFromDirectory(join(pluginsDir, 'pkg-billing'), { state: 'published', channel: 'stable' })
// `publishFromDirectory` returns the artifact itself (no `ok` field) — checked by shape.
ok('发布制品（不指定任何组）', published?.name === '@dsh-internal/dsh-plugin-billing', JSON.stringify(published).slice(0, 110))

// ------------------------------------------------------------------ the question
const catalogBefore = await call('GET', '/dsh-market/catalog', undefined, alice)
const entryBefore = catalogBefore.body?.entries?.find((entry) => entry.name === '@dsh-internal/dsh-plugin-billing')
/**
 * The catalog LISTS an artifact the caller cannot install, with a reason.
 *
 * That is deliberate and worth pinning: "you can see it exists but not install it, and
 * here is why" is answerable, whereas hiding it produces "why can't I see the plugin
 * my colleague has". The INSTALL decision is what the policy gates, not visibility.
 */
ok('发布后成员能看到它，但 canInstall=false', entryBefore !== undefined && entryBefore.canInstall === false, JSON.stringify(entryBefore?.reason))
ok('且给出可读原因（未加入任何组）', entryBefore?.reason === 'E_NO_GROUP', String(entryBefore?.reason))
ok('发布本身不授予安装权', entryBefore?.canInstall !== true, `canInstall=${entryBefore?.canInstall}`)

// A group carrying a glob that COVERS the plugin, added AFTER publication.
const group = await call('POST', '/dsh-market/admin/groups', { id: 'billing', description: '计费' }, admin)
ok('建组 billing', group.status === 200, `status=${group.status}`)
// The field is `pluginPattern`, not `pattern` — the first version sent `pattern` and got
// a 400 it then misreported as "glob rules do not work".
const rule = await call(
  'POST',
  '/dsh-market/admin/grants',
  { groupId: 'billing', pluginPattern: '@dsh-internal/dsh-plugin-*', effect: 'allow' },
  admin,
)
ok('给组加 **glob** 规则（不是逐个插件指定）', rule.status === 200, `status=${rule.status} ${JSON.stringify(rule.body).slice(0, 80)}`)
await call('POST', '/dsh-market/admin/membership', { username: 'alice', groupId: 'billing' }, admin)

const catalogAfter = await call('GET', '/dsh-market/catalog', undefined, alice)
const entryAfter = catalogAfter.body?.entries?.find((entry) => entry.name === '@dsh-internal/dsh-plugin-billing')
ok('加入组后该插件立刻可安装（规则是模式，不需要点名这个插件）', entryAfter?.canInstall === true, JSON.stringify(entryAfter?.reason ?? entryAfter?.canInstall))

console.log('')
console.log('结论：')
console.log('  · 发布 = 把制品放进市场，**不授予任何人**（canInstall 仍为 false）。')
console.log('  · catalog 会列出看得到但装不了的插件，并给出原因——这是有意的，便于排查。')
console.log('  · 授权 = 组 + glob 规则，命中即生效，**不需要点名具体插件**。')
console.log('  · 所以发布表单要权限组，等于把「制品存在」和「谁能装」两件事混在一起。')
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
app.db.close()
// Remove the scratch directory. Every one of these probes creates one; the first three
// did not clean up and quietly left a directory behind on every run.
rmSync(workDir, { recursive: true, force: true })
process.exit(problems ? 1 : 0)
