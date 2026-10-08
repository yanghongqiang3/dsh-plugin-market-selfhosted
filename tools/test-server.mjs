/**
 * End-to-end checks for the standalone market server.
 *
 *   node tools/test-server.mjs
 *
 * Boots the real server in-process on an ephemeral port with a throwaway SQLite
 * file and storage directory, publishes a real artifact, and drives the whole
 * HTTP surface. Nothing here touches the operator's data.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createApp } from '../server/index.mjs'
import { extractTarGz } from '../server/lib/artifacts.js'

let problems = 0
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? `  ${extra}` : ''}`)
  else {
    problems += 1
    console.error(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-market-server-'))
const storageDir = join(workDir, 'storage')
const app = createApp({ dbFile: join(workDir, 'market.db'), storageDir })
const { server, store, artifacts } = app

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`
console.log(`base: ${BASE}`)
console.log(`work: ${workDir}\n`)

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text.slice(0, 200) }
  }
  return { status: response.status, headers: response.headers, body: parsed, bytes: Buffer.from(text) }
}

// ------------------------------------------------------------ 1. bootstrap

console.log('--- 引导与登录 ---')
ok('首次启动创建了初始管理员', store.countUsers() === 1, `users=${store.countUsers()}`)

const health = await call('GET', '/dsh-market/health')
ok('health 可用', health.status === 200 && health.body.ok === true)

/**
 * The two surfaces, and where administration is reachable.
 *
 * The console is served BY THIS SERVICE, at a URL, with no DSH involved: it must not
 * need the host plugin, a local profile, or the shell. The root route reports where
 * it is so the address is discoverable without reading the source.
 */
{
  const root = await call('GET', '/')
  ok('根路由报告控制台地址', root.status === 200 && root.body.console === '/console', root.body?.console)

  const consolePage = await fetch(`${BASE}/console`)
  const consoleHtml = await consolePage.text()
  ok('GET /console 返回页面', consolePage.status === 200 && consoleHtml.includes('服务端控制台'))
  ok('控制台不依赖 DSH 宿主插件', !consoleHtml.includes('/dsh-market/config'))
  ok('控制台不含安装入口', !consoleHtml.includes('/dsh-market/install'))

  for (const asset of ['market.css', 'console.css', 'shared.js']) {
    const response = await fetch(`${BASE}/dsh-market/assets/${asset}`)
    const text = await response.text()
    ok(`静态资源 ${asset} 可达`, response.status === 200 && text.length > 0, `${text.length} B`)
  }

  // Static routes are unauthenticated on purpose: a login page that needs a token
  // to load its own CSS cannot load.
  const anonConsole = await fetch(`${BASE}/console`, { redirect: 'manual' })
  ok('控制台页面无需令牌即可取回', anonConsole.status === 200, `status=${anonConsole.status}`)

  const missing = await fetch(`${BASE}/dsh-market/assets/../../server/index.mjs`)
  ok('静态路由不接受路径穿越', missing.status !== 200, `status=${missing.status}`)
}

const anon = await call('GET', '/dsh-market/catalog')
ok('未登录访问目录 -> 401', anon.status === 401, `status=${anon.status} code=${anon.body?.code}`)

const badLogin = await call('POST', '/dsh-market/auth/login', {
  body: { username: 'admin', password: 'nope' },
})
ok('错误密码 -> 401', badLogin.status === 401, `status=${badLogin.status}`)

const login = await call('POST', '/dsh-market/auth/login', {
  body: { username: 'admin', password: 'dsh-admin' },
})
ok('默认管理员可登录', login.status === 200 && Boolean(login.body.token))
ok('首登要求改密', login.body.mustChangePassword === true)
let adminToken = login.body.token

const gated = await call('GET', '/dsh-market/catalog', { token: adminToken })
ok('未改密时目录 -> 403', gated.status === 403 && gated.body.code === 'E_MUST_CHANGE_PASSWORD', `${gated.status}/${gated.body?.code}`)

const weak = await call('POST', '/dsh-market/auth/password', { token: adminToken, body: { newPassword: 'short' } })
ok('过短密码被拒', weak.status === 400 && weak.body.code === 'E_WEAK_PASSWORD')

const changed = await call('POST', '/dsh-market/auth/password', {
  token: adminToken,
  body: { newPassword: 'admin-strong-password' },
})
ok('改密成功', changed.status === 200, `status=${changed.status}`)

const me = await call('GET', '/dsh-market/auth/me', { token: adminToken })
ok('改密后可读身份', me.status === 200 && me.body.user.username === 'admin')
ok('响应标明 role', me.body.role === 'admin', String(me.body.role))

// -------------------------------------------------------------- 2. artifact

console.log('\n--- 发布制品 ---')
const pkgDir = join(workDir, 'dsh-plugin-demo')
mkdirSync(join(pkgDir, 'lib'), { recursive: true })
writeFileSync(
  join(pkgDir, 'package.json'),
  JSON.stringify({ name: '@dsh-internal/dsh-plugin-demo', version: '1.2.3', description: '演示插件' }, null, 2),
)
writeFileSync(join(pkgDir, 'market.json'), JSON.stringify({ owner: 'platform', permissions: ['tools'] }, null, 2))
writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export function apply() {}\n')
writeFileSync(join(pkgDir, 'README.md'), '# demo\n')

const published = artifacts.publishFromDirectory(pkgDir, { publishedBy: 'cli' })
ok('发布返回元数据', published.name === '@dsh-internal/dsh-plugin-demo' && published.version === '1.2.3')
ok('记录了 sha256', /^[0-9a-f]{64}$/.test(published.sha256), published.sha256.slice(0, 16))
ok('记录了大小', published.sizeBytes > 0, `${published.sizeBytes} 字节`)
ok('默认状态为 published', published.status === 'published')
ok('摘要回填自 package.json', published.summary === '演示插件', published.summary)

const archive = artifacts.readVerified(published)
ok('落盘的字节与登记的哈希一致', archive.ok === true, archive.code ?? '')
const files = extractTarGz(archive.bytes)
ok('归档可解出 package.json', files.has('package.json'))
ok('归档可解出 lib/index.js', files.has('lib/index.js'))
ok('归档内容正确', String(files.get('lib/index.js')).includes('export function apply'))
ok('归档不含 node_modules', ![...files.keys()].some((name) => name.startsWith('node_modules')))

// 同样内容重复发布必须得到同样的哈希（确定性打包）
const again = artifacts.publishFromDirectory(pkgDir, { publishedBy: 'cli' })
ok('重复发布哈希稳定（打包确定性）', again.sha256 === published.sha256, `${again.sha256.slice(0, 12)} vs ${published.sha256.slice(0, 12)}`)

// --------------------------------------------------------- 3. permission gate

console.log('\n--- 权限判定 ---')
const adminCatalog = await call('GET', '/dsh-market/catalog', { token: adminToken })
const entry = adminCatalog.body.entries.find((item) => item.name === '@dsh-internal/dsh-plugin-demo')
ok('目录里能看到已发布插件', Boolean(entry))
ok('admin 无组 -> 不可安装（默认拒绝）', entry.canInstall === false && entry.reason === 'E_NO_GROUP', String(entry.reason))

const deniedInstall = await call('GET', '/dsh-market/download?name=@dsh-internal/dsh-plugin-demo&version=1.2.3', { token: adminToken })
ok('无权限下载 -> 403', deniedInstall.status === 403, `status=${deniedInstall.status} code=${deniedInstall.body?.code}`)

const authorizeDenied = await call('POST', '/dsh-market/authorize', {
  token: adminToken,
  body: { name: '@dsh-internal/dsh-plugin-demo', version: '1.2.3' },
})
ok('无权限 authorize -> 403', authorizeDenied.status === 403, `status=${authorizeDenied.status}`)

// 建组、建号、授权
await call('POST', '/dsh-market/admin/groups', {
  token: adminToken,
  body: { id: 'billing', description: '计费组' },
})
const createdUser = await call('POST', '/dsh-market/admin/users', {
  token: adminToken,
  body: { username: 'alice', password: 'alice-initial-password', displayName: '爱丽丝', groups: ['billing'] },
})
ok('管理员建号并指定组', createdUser.status === 200 && createdUser.body.user.groups.includes('billing'))

const granted = await call('POST', '/dsh-market/admin/grants', {
  token: adminToken,
  body: { groupId: 'billing', pluginPattern: '@dsh-internal/dsh-plugin-*' },
})
ok('添加 allow 规则', granted.status === 200)

const aliceLogin = await call('POST', '/dsh-market/auth/login', {
  body: { username: 'alice', password: 'alice-initial-password' },
})
const aliceToken = aliceLogin.body.token
await call('POST', '/dsh-market/auth/password', { token: aliceToken, body: { newPassword: 'alice-strong-password' } })

const aliceCatalog = await call('GET', '/dsh-market/catalog', { token: aliceToken })
const aliceEntry = aliceCatalog.body.entries.find((item) => item.name === '@dsh-internal/dsh-plugin-demo')
ok('被授权用户可安装', aliceEntry.canInstall === true, String(aliceEntry.reason))

// 下载 + 校验
const download = await fetch(`${BASE}/dsh-market/download?name=@dsh-internal/dsh-plugin-demo&version=1.2.3`, {
  headers: { authorization: `Bearer ${aliceToken}` },
})
ok('下载返回 200', download.status === 200, `status=${download.status}`)
const headerHash = download.headers.get('x-artifact-sha256')
const bodyBytes = Buffer.from(await download.arrayBuffer())
const bodyHash = createHash('sha256').update(bodyBytes).digest('hex')
ok('响应头带 sha256', /^[0-9a-f]{64}$/.test(headerHash ?? ''), String(headerHash).slice(0, 16))
ok('实际下载字节的哈希与响应头一致', bodyHash === headerHash, `${bodyHash.slice(0, 12)} vs ${String(headerHash).slice(0, 12)}`)
ok('下载字节与登记的哈希一致', bodyHash === published.sha256)
ok('下载内容可解包', extractTarGz(bodyBytes).has('package.json'))

// deny 优先
await call('POST', '/dsh-market/admin/grants', {
  token: adminToken,
  body: { groupId: 'billing', pluginPattern: '@dsh-internal/dsh-plugin-demo', effect: 'deny' },
})
const afterDeny = await call('GET', '/dsh-market/catalog', { token: aliceToken })
const deniedEntry = afterDeny.body.entries.find((item) => item.name === '@dsh-internal/dsh-plugin-demo')
ok('deny 覆盖 allow', deniedEntry.canInstall === false && deniedEntry.reason === 'E_FORBIDDEN_DENY', String(deniedEntry.reason))

const deniedDownload = await call('GET', '/dsh-market/download?name=@dsh-internal/dsh-plugin-demo&version=1.2.3', { token: aliceToken })
ok('deny 后下载被拒', deniedDownload.status === 403 && deniedDownload.body.code === 'E_FORBIDDEN_DENY')

// 撤销 grants 后重新授权，测状态机
await call('POST', '/dsh-market/admin/grants', {
  token: adminToken,
  body: { groupId: 'billing', pluginPattern: '@dsh-internal/dsh-plugin-demo', remove: true },
})
await call('POST', '/dsh-market/admin/artifacts/state', {
  token: adminToken,
  body: { name: '@dsh-internal/dsh-plugin-demo', version: '1.2.3', channel: 'stable', state: 'revoked' },
})
const afterRevoke = await call('GET', '/dsh-market/catalog', { token: aliceToken })
const revokedEntry = afterRevoke.body.entries.find((item) => item.name === '@dsh-internal/dsh-plugin-demo')
ok('撤回后不可安装', revokedEntry.canInstall === false && revokedEntry.reason === 'E_REVOKED', String(revokedEntry.reason))

// ------------------------------------------------------------- 4. 哈希防护

console.log('\n--- 哈希防护 ---')
await call('POST', '/dsh-market/admin/artifacts/state', {
  token: adminToken,
  body: { name: '@dsh-internal/dsh-plugin-demo', version: '1.2.3', channel: 'stable', state: 'published' },
})
await call('POST', '/dsh-market/admin/grants', {
  token: adminToken,
  body: { groupId: 'billing', pluginPattern: '@dsh-internal/*' },
})

// 篡改磁盘上的归档：服务端必须拒绝下发，而不是发出去让客户端发现
const stored = artifacts.contain('@dsh-internal/dsh-plugin-demo', '1.2.3', 'stable.tgz')
writeFileSync(stored, Buffer.from('tampered bytes'))
const corrupt = await call('GET', '/dsh-market/download?name=@dsh-internal/dsh-plugin-demo&version=1.2.3', { token: aliceToken })
ok('制品被篡改 -> 服务端拒绝下载', corrupt.status === 500 && corrupt.body.code === 'E_HASH_MISMATCH', `${corrupt.status}/${corrupt.body?.code}`)

// ------------------------------------------------------- 5. 账号状态即时生效

console.log('\n--- 账号状态 ---')
const disabled = await call('POST', '/dsh-market/admin/status', {
  token: adminToken,
  body: { username: 'alice', status: 'disabled' },
})
ok('停用账号', disabled.status === 200, `status=${disabled.status}`)
ok('停用同时吊销会话', disabled.body.revokedSessions >= 1, `revoked=${disabled.body.revokedSessions}`)
const afterDisable = await call('GET', '/dsh-market/catalog', { token: aliceToken })
ok('停用后旧令牌立即失效', afterDisable.status === 401, `status=${afterDisable.status}`)

const relogin = await call('POST', '/dsh-market/auth/login', {
  body: { username: 'alice', password: 'alice-strong-password' },
})
ok('停用账号无法登录', relogin.status === 401 && relogin.body.code === 'E_ACCOUNT_DISABLED', String(relogin.body?.code))

// -------------------------------------------------------------- 6. 非管理员

console.log('\n--- 越权访问 ---')
await call('POST', '/dsh-market/admin/status', { token: adminToken, body: { username: 'alice', status: 'active' } })
const alice2 = await call('POST', '/dsh-market/auth/login', {
  body: { username: 'alice', password: 'alice-strong-password' },
})
const nonAdmin = await call('GET', '/dsh-market/admin/users', { token: alice2.body.token })
ok('普通用户访问管理接口 -> 403 E_NOT_ADMIN', nonAdmin.status === 403 && nonAdmin.body.code === 'E_NOT_ADMIN', `${nonAdmin.status}/${nonAdmin.body?.code}`)

// ------------------------------------------------------------- 7. 审计与清理

console.log('\n--- 审计与清理 ---')
const audit = store.recentAudit(200)
ok('记录了登录成功', audit.some((row) => row.action === 'login.ok'))
ok('记录了登录失败', audit.some((row) => row.action === 'login.fail'))
ok('记录了拒绝', audit.some((row) => row.action === 'deny'))
ok('记录了发布', audit.some((row) => row.action === 'artifact.publish'))
ok('记录了制品被篡改', audit.some((row) => row.action === 'artifact.corrupt'))
ok('记录了下载', audit.some((row) => row.action === 'download'))
const pruned = store.prune()
ok('prune 可执行', typeof pruned.sessions === 'number')

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
server.close()
try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  /* windows file locks are not fatal */
}
process.exit(problems ? 1 : 0)
