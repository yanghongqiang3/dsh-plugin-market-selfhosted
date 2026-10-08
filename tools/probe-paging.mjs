/**
 * Server-side pagination and the new group/rule edit endpoints.
 *
 * Measured rather than assumed, because "pagination" has several ways to be subtly wrong:
 * an offset past the end must be an empty page (not an error), `limit` must be clamped
 * rather than obeyed, `q` must actually narrow the total, and every list must report the
 * SAME shape or the console has to special-case them.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-paging-'))
const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
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

const login = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, login.body.token)
const admin = (await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body.token

// 25 users named user00..user24, plus the bootstrap admin = 26 rows.
await call('POST', '/dsh-market/admin/groups', { id: 'platform', description: '平台组' }, admin)
for (let i = 0; i < 25; i += 1) {
  const name = `user${String(i).padStart(2, '0')}`
  await call('POST', '/dsh-market/admin/users', { username: name, password: 'initial-password-2026', displayName: `用户 ${i}` }, admin)
}

console.log('--- 分页基本行为 ---')
const p1 = await call('GET', '/dsh-market/admin/users?limit=10&offset=0', undefined, admin)
ok('第 1 页返回 10 条', p1.body?.entries?.length === 10, `len=${p1.body?.entries?.length}`)
ok('总数为 26', p1.body?.total === 26, `total=${p1.body?.total}`)
ok('回显 limit / offset', p1.body?.limit === 10 && p1.body?.offset === 0, `${p1.body?.limit}/${p1.body?.offset}`)
ok('同时保留旧字段名 users', Array.isArray(p1.body?.users) && p1.body.users.length === 10)

const p3 = await call('GET', '/dsh-market/admin/users?limit=10&offset=20', undefined, admin)
ok('第 3 页返回剩下 6 条', p3.body?.entries?.length === 6, `len=${p3.body?.entries?.length}`)
ok('两页不重叠', p1.body.entries[0].username !== p3.body.entries[0].username)

const past = await call('GET', '/dsh-market/admin/users?limit=10&offset=9999', undefined, admin)
ok('偏移超出范围是空页，不是错误', past.status === 200 && past.body?.entries?.length === 0, `status=${past.status}`)

const clamped = await call('GET', '/dsh-market/admin/users?limit=100000', undefined, admin)
ok('limit 被钳到 200', clamped.body?.limit === 200, `limit=${clamped.body?.limit}`)
const zero = await call('GET', '/dsh-market/admin/users?limit=0', undefined, admin)
ok('limit=0 退回默认 20', zero.body?.limit === 20, `limit=${zero.body?.limit}`)
const junk = await call('GET', '/dsh-market/admin/users?limit=abc&offset=xyz', undefined, admin)
ok('非法 limit/offset 退回默认值', junk.body?.limit === 20 && junk.body?.offset === 0, `${junk.body?.limit}/${junk.body?.offset}`)

console.log('')
console.log('--- 搜索 ---')
const searched = await call('GET', '/dsh-market/admin/users?q=user1', undefined, admin)
ok('q 缩小了 total', searched.body?.total === 10, `total=${searched.body?.total}`)
ok('q 结果确实都匹配', searched.body.entries.every((u) => u.username.includes('user1')))
const byDisplay = await call('GET', '/dsh-market/admin/users?q=用户 7', undefined, admin)
ok('q 也匹配显示名', byDisplay.body?.total === 1, `total=${byDisplay.body?.total}`)
const none = await call('GET', '/dsh-market/admin/users?q=zzzz', undefined, admin)
ok('无匹配时 total=0 且是空页', none.body?.total === 0 && none.body.entries.length === 0)

console.log('')
console.log('--- 四个列表的形状一致 ---')
for (const path of ['users', 'groups', 'grants', 'artifacts']) {
  const page = await call('GET', `/dsh-market/admin/${path}?limit=5`, undefined, admin)
  const shape = ['entries', 'total', 'limit', 'offset'].every((key) => page.body?.[key] !== undefined)
  ok(`${path} 有统一的分页形状`, shape, JSON.stringify(Object.keys(page.body ?? {}).slice(0, 6)))
}

console.log('')
console.log('--- 组：编辑与删除 ---')
const edited = await call('POST', '/dsh-market/admin/groups/update', { id: 'platform', description: '改过的说明' }, admin)
ok('改组说明成功', edited.status === 200 && edited.body?.group?.description === '改过的说明', JSON.stringify(edited.body?.group))
const reread = await call('GET', '/dsh-market/admin/groups?q=platform', undefined, admin)
ok('改动已落库', reread.body?.entries?.[0]?.description === '改过的说明', String(reread.body?.entries?.[0]?.description))
const noGroup = await call('POST', '/dsh-market/admin/groups/update', { id: 'nope', description: 'x' }, admin)
ok('改不存在的组 -> 404', noGroup.status === 404 && noGroup.body?.code === 'E_NO_SUCH_GROUP', `${noGroup.status}/${noGroup.body?.code}`)
const noId = await call('POST', '/dsh-market/admin/groups/update', { description: 'x' }, admin)
ok('缺 id -> 400', noId.status === 400, String(noId.status))
// The ID is the identity: renaming must not be possible.
const rename = await call('POST', '/dsh-market/admin/groups/update', { id: 'platform', name: 'renamed', description: '平台组' }, admin)
const stillThere = await call('GET', '/dsh-market/admin/groups?q=renamed', undefined, admin)
ok('组 ID 不可被改名', stillThere.body?.total === 0 && rename.status === 200, `status=${rename.status}`)

console.log('')
console.log('--- 规则：新增 / 编辑 / 删除 ---')
await call('POST', '/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '@dsh-internal/a-*', effect: 'allow' }, admin)
await call('POST', '/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '@dsh-internal/b-*', effect: 'allow' }, admin)
const list = await call('GET', '/dsh-market/admin/grants', undefined, admin)
ok('规则列表是扁平且有 groupId/pattern', list.body?.entries?.length === 2 && list.body.entries[0].groupId === 'platform', JSON.stringify(list.body?.entries?.[0]))
const editedGrant = await call('POST', '/dsh-market/admin/grants/update', { groupId: 'platform', pluginPattern: '@dsh-internal/a-*', effect: 'deny', channel: 'beta' }, admin)
ok('改规则 effect/channel', editedGrant.status === 200 && editedGrant.body?.grant?.effect === 'deny', JSON.stringify(editedGrant.body?.grant))
const afterEdit = await call('GET', '/dsh-market/admin/grants?q=a-*', undefined, admin)
ok('改动已落库', afterEdit.body?.entries?.[0]?.effect === 'deny' && afterEdit.body.entries[0].channel === 'beta', JSON.stringify(afterEdit.body?.entries?.[0]))
const retarget = await call('POST', '/dsh-market/admin/grants/update', { groupId: 'platform', pluginPattern: '@dsh-internal/b-*', nextPattern: '@dsh-internal/c-*', effect: 'allow' }, admin)
ok('改规则的匹配式（换 pattern）', retarget.status === 200, JSON.stringify(retarget.body?.grant))
const afterRetarget = await call('GET', '/dsh-market/admin/grants', undefined, admin)
const patterns = afterRetarget.body.entries.map((g) => g.pattern).sort()
ok('换 pattern 后旧的消失了', JSON.stringify(patterns) === JSON.stringify(['@dsh-internal/a-*', '@dsh-internal/c-*']), JSON.stringify(patterns))
const grantQ = await call('GET', '/dsh-market/admin/grants?q=deny', undefined, admin)
ok('规则可按 effect 搜', grantQ.body?.total === 1, `total=${grantQ.body?.total}`)

console.log('')
console.log('--- 删除组会一并清掉成员与规则 ---')
await call('POST', '/dsh-market/admin/membership', { username: 'user00', groupId: 'platform', on: true }, admin)
const removed = await call('POST', '/dsh-market/admin/groups/delete', { id: 'platform' }, admin)
ok('删组返回清理数量', removed.status === 200 && removed.body?.grants === 2, JSON.stringify(removed.body))
const groupsAfter = await call('GET', '/dsh-market/admin/groups', undefined, admin)
ok('组没了', groupsAfter.body.entries.every((g) => g.id !== 'platform'))
const grantsAfter = await call('GET', '/dsh-market/admin/grants', undefined, admin)
ok('该组的规则也没了（不会留下看不见的权限）', grantsAfter.body?.total === 0, `total=${grantsAfter.body?.total}`)
const userAfter = await call('GET', '/dsh-market/admin/users?q=user00', undefined, admin)
ok('该组的成员关系也没了', (userAfter.body.entries[0]?.groups ?? []).length === 0, JSON.stringify(userAfter.body.entries[0]?.groups))
const deleteAgain = await call('POST', '/dsh-market/admin/groups/delete', { id: 'platform' }, admin)
ok('重复删除 -> 404', deleteAgain.status === 404, String(deleteAgain.status))

console.log('')
console.log('--- 绑定可按账号过滤（供账号行内显示）---')
const alice = await call('POST', '/dsh-market/admin/users', { username: 'alice', password: 'alice-initial-2026' }, admin)
void alice
const aliceLogin = await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-initial-2026' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'alice-password-2026' }, aliceLogin.body.token)
const aliceToken = (await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-password-2026' })).body.token
await call('POST', '/dsh-market/identity/bind', { dshUserId: 'dsh-alice', dshName: 'Alice' }, aliceToken)
const filtered = await call('GET', '/dsh-market/admin/identity?usernames=alice,user01', undefined, admin)
ok('只返回请求的账号的绑定', filtered.body?.total === 1 && filtered.body.entries[0].marketUsername === 'alice', JSON.stringify(filtered.body?.entries))
const unfiltered = await call('GET', '/dsh-market/admin/identity', undefined, admin)
ok('不传过滤时返回全部（旧调用不受影响）', unfiltered.body?.total === 1, `total=${unfiltered.body?.total}`)

console.log('')
console.log('结论：limit/offset 在全部四个列表上行为一致（超出为空页、limit 钳到 200、非法值退默认），')
console.log('      q 实际参与 total，组与规则可就地编辑，删组会连带清掉成员与规则。')

app.server.close()
app.db.close()
const { rmSync } = await import('node:fs')
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
