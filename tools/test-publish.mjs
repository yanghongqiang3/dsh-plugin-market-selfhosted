/**
 * End-to-end checks for the HTTP publish path — the one that lets a contributor
 * push a plugin without shell access to the server.
 *
 *   node tools/test-publish.mjs
 *
 * Boots a real service in-process, then drives the real CLI against it as a
 * subprocess, so both sides of the contract are exercised.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createApp } from '../server/index.mjs'
import { collectFiles, packTarGz } from '../server/lib/pack.js'

let problems = 0
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? `  ${extra}` : ''}`)
  else {
    problems += 1
    console.error(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-market-publish-'))
const tokenFile = join(workDir, 'token.json')
const app = createApp({ dbFile: join(workDir, 'market.db'), storageDir: join(workDir, 'storage') })
const { server, store, artifacts } = app
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const service = `http://127.0.0.1:${server.address().port}`
console.log(`service ${service}`)
console.log(`work    ${workDir}\n`)

/** Run the real CLI and capture stdout+stderr. */
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server/cli.mjs', ...args], {
      cwd: 'E:\\workspace\\dsh',
      env: { ...process.env, MARKET_TOKEN_FILE: tokenFile, MARKET_SERVICE_URL: service },
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('close', (code) => resolve({ code, out }))
  })
}

function makePackage(name, version, extraMeta = {}) {
  const dir = join(workDir, name.replace(/[@/]/g, '_'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name, version, description: `${name} 的说明` }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'market.json'), `${JSON.stringify({ owner: 'platform', ...extraMeta }, null, 2)}\n`)
  writeFileSync(join(dir, 'lib', 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  return dir
}

// ------------------------------------------------------------ 1. unauthenticated

console.log('--- 未登录 ---')
const anonPublish = await fetch(`${service}/dsh-market/publish?commit=1`, {
  method: 'POST',
  headers: { 'content-type': 'application/gzip' },
  body: Buffer.from('x'),
})
ok('未登录上传 -> 401', anonPublish.status === 401, `status=${anonPublish.status}`)

const anonDry = await fetch(`${service}/dsh-market/publish`, {
  method: 'POST',
  headers: { 'content-type': 'application/gzip' },
  body: Buffer.from('x'),
})
ok('未登录预检 -> 401', anonDry.status === 401, `status=${anonDry.status}`)

// ------------------------------------------------------------------- 2. login

console.log('\n--- CLI 登录 ---')
store.setPassword('admin', 'admin-strong-password', { mustChange: false, by: 'test' })
const login = await cli(['login', '--username', 'admin', '--password', 'admin-strong-password'])
ok('login 退出码 0', login.code === 0, `code=${login.code}`)
ok('login 报告了角色', login.out.includes('admin'), login.out.trim().split('\n')[0])
ok('令牌已写入文件', readFileSync(tokenFile, 'utf8').includes('token'))

const whoami = await cli(['whoami'])
ok('whoami 能读到身份', whoami.out.includes('admin'), whoami.out.trim().split('\n')[0])

const badLogin = await cli(['login', '--username', 'admin', '--password', 'wrong'])
ok('错误密码 login 退出码非 0', badLogin.code !== 0)

// ----------------------------------------------------------------- 3. dry run

console.log('\n--- 预检（不写入）---')
const demoDir = makePackage('@dsh-internal/dsh-plugin-demo', '1.0.0')
const dry = await cli(['publish', '--dir', demoDir, '--dry-run'])
ok('预检退出码 0', dry.code === 0, `code=${dry.code}`)
ok('预检报告 sha256', /sha256\s+[0-9a-f]{64}/.test(dry.out), dry.out.split('\n').filter((l) => l.includes('sha256'))[0] ?? '')
ok('预检未写入服务端', artifacts.catalogRows().length === 0, `artifacts=${artifacts.catalogRows().length}`)
ok('预检提示未写入', dry.out.includes('未写入'), '')

// ------------------------------------------------------------------ 4. publish

console.log('\n--- 正式发布 ---')
const published = await cli(['publish', '--dir', demoDir])
ok('发布退出码 0', published.code === 0, `code=${published.code}`)
const rows = artifacts.catalogRows()
ok('服务端目录里有该插件', rows.length === 1 && rows[0].name === '@dsh-internal/dsh-plugin-demo', JSON.stringify(rows.map((r) => r.name)))
ok('版本正确', rows[0]?.version === '1.0.0', String(rows[0]?.version))
ok('摘要取自 package.json', rows[0]?.summary === '@dsh-internal/dsh-plugin-demo 的说明', String(rows[0]?.summary))
ok('归属取自 market.json', rows[0]?.owner === 'platform', String(rows[0]?.owner))
ok('CLI 报告的哈希与服务端一致', published.out.includes(rows[0].sha256), String(rows[0].sha256).slice(0, 16))
ok('制品文件已落盘', artifacts.sizeOf(rows[0]) > 0, `${artifacts.sizeOf(rows[0])} 字节`)

// The archive that arrived over HTTP must be the SAME bytes the CLI packed.
const localArchive = packTarGz(demoDir, collectFiles(demoDir))
const verified = artifacts.readVerified(rows[0])
ok('服务端存储的字节与本地打包一致', verified.ok && Buffer.compare(verified.bytes, localArchive) === 0)

// ------------------------------------------------------ 5. malformed uploads

console.log('\n--- 拒绝畸形上传 ---')
const good = packTarGz(demoDir, collectFiles(demoDir))

async function uploadRaw(body, query = '?commit=1') {
  const response = await fetch(`${service}/dsh-market/publish${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/gzip' },
    body,
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const adminLogin = await fetch(`${service}/dsh-market/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin-strong-password' }),
})
const token = (await adminLogin.json()).token
async function uploadAuthed(body, query = '?commit=1') {
  const response = await fetch(`${service}/dsh-market/publish${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/gzip', authorization: `Bearer ${token}` },
    body,
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const notGzip = await uploadAuthed(Buffer.from('this is not a gzip archive'))
ok('非 gzip 上传 -> E_BAD_ARCHIVE', notGzip.status === 400 && notGzip.body?.code === 'E_BAD_ARCHIVE', `${notGzip.status}/${notGzip.body?.code}`)

const empty = await uploadAuthed(Buffer.alloc(0))
ok('空上传 -> E_EMPTY_BODY', empty.status === 400 && empty.body?.code === 'E_EMPTY_BODY', `${empty.status}/${empty.body?.code}`)

const noManifest = await uploadAuthed(packTarGzFromMap({ 'lib/index.js': 'export {}\n' }))
ok('缺 package.json -> E_NOT_PACKAGE', noManifest.status === 400 && noManifest.body?.code === 'E_NOT_PACKAGE', `${noManifest.status}/${noManifest.body?.code}`)

const badJson = await uploadAuthed(packTarGzFromMap({ 'package.json': '{ not json' }))
ok('package.json 非法 -> E_BAD_PACKAGE_JSON', badJson.status === 400 && badJson.body?.code === 'E_BAD_PACKAGE_JSON', `${badJson.status}/${badJson.body?.code}`)

const escaping = await uploadAuthed(tarWithRawEntry('../evil.txt', 'x', '{"name":"@a/b","version":"1.0.0"}'))
ok('路径逃逸 -> 被拒', escaping.status === 400, `${escaping.status}/${escaping.body?.code}`)

const absolute = await uploadAuthed(tarWithRawEntry('/etc/evil.txt', 'x', '{"name":"@a/b","version":"1.0.0"}'))
ok('绝对路径 -> 被拒', absolute.status === 400, `${absolute.status}/${absolute.body?.code}`)

const symlink = await uploadAuthed(tarWithRawEntry('link', '', '{"name":"@a/b","version":"1.0.0"}', '2'))
ok('符号链接条目 -> 被拒', symlink.status === 400, `${symlink.status}/${symlink.body?.code}`)

const badState = await uploadAuthed(good, '?commit=1&state=whatever')
ok('非法状态 -> 被拒', badState.status === 400, `${badState.status}/${badState.body?.code}`)

ok('畸形上传后目录未被污染', artifacts.catalogRows().length === 1, `artifacts=${artifacts.catalogRows().length}`)

/** Pack an in-memory file map (all paths safe by construction). */
function packTarGzFromMap(map) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bad-'))
  for (const [relative, content] of Object.entries(map)) {
    const target = join(dir, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return packTarGz(dir, collectFiles(dir))
}

/**
 * Hand-build a tar.gz whose header names an entry the packer would never emit —
 * an escaping path, an absolute path, or a non-regular-file type. `packTarGz`
 * cannot produce these by design, which is exactly why the server-side check
 * needs its own test input.
 */
function tarWithRawEntry(name, content, packageJson, typeFlag = '0') {
  const blocks = []
  const data = Buffer.from(content)

  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'utf8')
  header.write('0000000\0', 108, 8, 'utf8')
  header.write('0000000\0', 116, 8, 'utf8')
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
  header.write('00000000000\0', 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write(typeFlag, 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))

  if (packageJson) {
    const pkg = Buffer.from(packageJson)
    const pkgHeader = Buffer.alloc(512)
    pkgHeader.write('package.json', 0, 100, 'utf8')
    pkgHeader.write('0000644\0', 100, 8, 'utf8')
    pkgHeader.write('0000000\0', 108, 8, 'utf8')
    pkgHeader.write('0000000\0', 116, 8, 'utf8')
    pkgHeader.write(`${pkg.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
    pkgHeader.write('00000000000\0', 136, 12, 'utf8')
    pkgHeader.write('        ', 148, 8, 'utf8')
    pkgHeader.write('0', 156, 1, 'utf8')
    pkgHeader.write('ustar\0', 257, 6, 'utf8')
    pkgHeader.write('00', 263, 2, 'utf8')
    let pkgSum = 0
    for (const byte of pkgHeader) pkgSum += byte
    pkgHeader.write(`${pkgSum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
    blocks.push(pkgHeader, pkg, Buffer.alloc((512 - (pkg.length % 512)) % 512))
  }

  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

// --------------------------------------------------------- 6. state transitions

console.log('\n--- 状态流转 ---')
const asDraft = await cli(['publish', '--dir', makePackage('@dsh-internal/dsh-plugin-wip', '0.1.0'), '--state', 'draft'])
ok('可发布为 draft', asDraft.code === 0, `code=${asDraft.code}`)
/**
 * The draft is checked through `listVersions`, NOT the catalog.
 *
 * The catalog lists what may be INSTALLED, and a draft may not be installed, so it is
 * absent from the catalog by design — asserting its presence there encoded the old
 * behaviour, where the catalog showed every state and the client rendered an install
 * button that `policy` then refused. The state is recorded either way; this proves it
 * without depending on a listing the draft does not belong in.
 */
const draftRows = artifacts.listVersions('@dsh-internal/dsh-plugin-wip')
ok('draft 状态已记录', draftRows[0]?.status === 'draft', String(draftRows[0]?.status))
ok(
  'draft 不出现在 catalog 里（不可安装，就不该被列出）',
  artifacts.catalogRows().every((row) => row.name !== '@dsh-internal/dsh-plugin-wip'),
)

// draft must not be installable even when granted
store.createGroup({ id: 'platform-test', name: 'platform', by: 'test' })
store.addGrant({ groupId: 'platform-test', pluginPattern: '@dsh-internal/*', by: 'test' })

const unauthorized = await fetch(`${service}/dsh-market/download?name=@dsh-internal/dsh-plugin-wip&version=0.1.0`, {
  headers: { authorization: `Bearer ${token}` },
})
const unauthorizedBody = await unauthorized.json().catch(() => null)
ok('draft 不可下载', unauthorized.status === 403, `${unauthorized.status}/${unauthorizedBody?.code}`)

// promote and confirm it becomes downloadable for a granted user
await fetch(`${service}/dsh-market/admin/artifacts/state`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ name: '@dsh-internal/dsh-plugin-wip', version: '0.1.0', channel: 'stable', state: 'published' }),
})
store.setMembership('admin', 'platform-test', true, { by: 'test' })
const nowAllowed = await fetch(`${service}/dsh-market/download?name=@dsh-internal/dsh-plugin-wip&version=0.1.0`, {
  headers: { authorization: `Bearer ${token}` },
})
ok('提升为 published 后可下载', nowAllowed.status === 200, `status=${nowAllowed.status}`)

// ------------------------------------------------------------------ 7. audit

console.log('\n--- 审计 ---')
const audit = store.recentAudit(100)
ok('记录了发布（含 via=upload）', audit.some((row) => row.action === 'artifact.publish' && row.detail?.via === 'upload'))
ok('记录了被拒的上传', audit.some((row) => row.action === 'artifact.reject'))
ok('记录了状态流转', audit.some((row) => row.action === 'artifact.state'))

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
server.close()
try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  /* windows locks */
}
process.exit(problems ? 1 : 0)

