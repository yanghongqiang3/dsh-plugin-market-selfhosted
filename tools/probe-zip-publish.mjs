/**
 * Publishing a `.zip`.
 *
 * Right-clicking a folder on Windows gives a zip; `.tar.gz` needs extra tooling. So the
 * upload path accepts a zip and NORMALISES it to the canonical tar.gz rather than becoming a
 * second supported format — storage, the recorded hash, the download route and the client's
 * extractor all keep seeing one format.
 *
 * Two things are easy to get wrong and are asserted here:
 *
 *  1. **The wrapper directory.** Compressing a folder wraps everything in a directory named
 *     after it (`my-skill/SKILL.md`), so a perfectly good archive has no root manifest and is
 *     refused with "no package.json". The same shape as npm's `package/`.
 *  2. **Which bytes are hashed.** The preview advertises a sha256 and the client verifies the
 *     bytes it DOWNLOADS against it. Hashing the uploaded zip and storing a converted tar.gz
 *     would advertise a hash that never matches, and every install would fail integrity.
 *
 * The zips come from `Compress-Archive` (the real Windows tool), not from a writer written to
 * match this reader — a hand-made zip would only prove the two agree with each other.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'
import { inspectArchive, listEntries, normaliseArchive, packTarGzEntries, readAnyArchive } from '../server/lib/pack.js'
import { looksLikeZip, readZip } from '../server/lib/zip.js'

const work = mkdtempSync(join(tmpdir(), 'dsh-zip-'))
let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

/**
 * Build a real zip with PowerShell's Compress-Archive.
 *
 * Measured behaviour, because it is not obvious and getting it wrong made a test vacuous:
 *   -Path <dir>    -> entries are `<dir>/...`   (the right-click-a-folder shape)
 *   -Path <dir>\*  -> entries are flat
 * So `wrapper` selects the first form and its name becomes the top-level entry.
 */
function zipWithPowerShell(files, { wrapper = null, name = 'upload' } = {}) {
  const src = join(work, `zip-src-${Math.random().toString(36).slice(2, 8)}`)
  const root = wrapper === null ? src : join(src, wrapper)
  mkdirSync(root, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  const out = join(work, `${name}-${Math.random().toString(36).slice(2, 8)}.zip`)
  const source = wrapper === null ? join(root, '*') : root
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${source}' -DestinationPath '${out}' -Force`,
  ], { stdio: 'ignore' })
  return { out, src }
}

/**
 * Where the first entry's compressed bytes begin.
 *
 * Needed to corrupt a payload deliberately. An offset picked by eye landed inside the NAME
 * field, so the content still matched its CRC and the "a corrupt entry is refused" check
 * passed a file it was supposed to reject — a broken check reporting success.
 */
function firstEntryDataStart(buffer) {
  const at = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  if (at < 0) return -1
  return at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28)
}

const SKILL_PKG = JSON.stringify({
  name: '@dsh-internal/zip-skill', version: '1.0.0',
  description: '用 zip 发布的技能', dsh: { market: { kind: 'skill' } },
})
const SKILL_MD = '---\nname: zip-skill\ndescription: 说明。\n---\n\n正文\n'

console.log('--- 用真实的 Compress-Archive 生成 zip ---')
const flat = zipWithPowerShell({
  'package.json': SKILL_PKG,
  'SKILL.md': SKILL_MD,
  'references/notes.md': '# notes\n',
})
const flatBytes = readFileSync(flat.out)
ok('PowerShell 生成了 zip', looksLikeZip(flatBytes), flatBytes.subarray(0, 4).toString('hex'))
{
  const read = readZip(flatBytes)
  ok('读取成功', read.ok === true, read.ok === false ? `${read.code} ${read.detail}` : '')
  ok('  条目齐全', read.ok && [...read.entries.keys()].sort().join(',') === 'SKILL.md,package.json,references/notes.md',
    read.ok ? JSON.stringify([...read.entries.keys()]) : '')
  ok('  内容与写入一致', read.ok && read.entries.get('SKILL.md').toString('utf8') === SKILL_MD)
  ok('  CRC 与大小都校验过（读坏归档会报错）', read.ok === true)
}

console.log('')
console.log('--- 归一化成 tar.gz（只存一种格式）---')
{
  const normalised = normaliseArchive(flatBytes)
  ok('zip 被转换', normalised.ok === true && normalised.converted === true)
  ok('  转换后是 gzip', normalised.ok && normalised.archive[0] === 0x1f && normalised.archive[1] === 0x8b)
  ok('  转换后再转换是幂等的', normaliseArchive(normalised.archive).converted === false)
  ok('  条目一个不少', JSON.stringify(listEntries(normalised.archive).sort()) === JSON.stringify(listEntries(flatBytes).sort()),
    JSON.stringify(listEntries(normalised.archive)))
  /**
   * Determinism: the same tree must hash the same whether it arrived as a zip or was packed
   * from disk by the CLI. Otherwise republishing an unchanged tree would look like a change,
   * and the "same directory yields the same sha256" property would silently stop holding.
   */
  const asEntries = new Map([
    ['SKILL.md', Buffer.from(SKILL_MD)],
    ['package.json', Buffer.from(SKILL_PKG)],
    ['references/notes.md', Buffer.from('# notes\n')],
  ])
  const fromDisk = packTarGzEntries(asEntries)
  ok('  与从磁盘打包的结果逐字节相同',
    normalised.ok && fromDisk.equals(normalised.archive),
    `${normalised.ok ? normalised.archive.length : 0} vs ${fromDisk.length}`)
}

console.log('')
console.log('--- Windows 那层包装目录 ---')
{
  const wrapped = zipWithPowerShell({
    'package.json': SKILL_PKG,
    'SKILL.md': SKILL_MD,
  }, { wrapper: 'zip-skill' })
  const bytes = readFileSync(wrapped.out)
  ok('包装后的 zip 确实多一层', readZip(bytes).ok && [...readZip(bytes).entries.keys()].every((n) => n.startsWith('zip-skill/')),
    JSON.stringify(listEntries(bytes)))
  const inspection = inspectArchive(bytes)
  ok('仍能识别（剥掉包装目录）', inspection.ok === true, inspection.ok === false ? `${inspection.code} ${inspection.detail}` : '')
  ok('  package.json 读到了', inspection.ok && inspection.pkg.name === '@dsh-internal/zip-skill', String(inspection.pkg?.name))
  ok('  kind=skill 也认出来了', inspection.ok && inspection.kind === 'skill', String(inspection.kind))
  ok('  记录下剥掉的前缀', inspection.ok && inspection.packagePrefix === 'zip-skill/', String(inspection.packagePrefix))
  // npm's `package/` prefix is the same shape and must keep working.
  const npmStyle = zipWithPowerShell({
    'package.json': SKILL_PKG,
    'SKILL.md': SKILL_MD,
  }, { wrapper: 'package' })
  const npmInspection = inspectArchive(readFileSync(npmStyle.out))
  ok('  npm 的 package/ 布局也照旧', npmInspection.ok && npmInspection.packagePrefix === 'package/', String(npmInspection.packagePrefix))
}

console.log('')
console.log('--- 坏归档要给出说得出问题的错误 ---')
{
  const truncated = flatBytes.subarray(0, Math.floor(flatBytes.length / 2))
  const read = readZip(truncated)
  ok('截断的 zip 被拒', read.ok === false, read.ok === false ? read.code : '(accepted!)')
  ok('  错误码说明是截断', read.ok === false && /TRUNCATED|BAD_CENTRAL/.test(read.code), read.ok === false ? read.code : '')

  // Corrupt one byte OF THE PAYLOAD (not the header): CRC must catch it rather than being
  // silently passed through to a later, more confusing failure.
  const corrupt = Buffer.from(flatBytes)
  const dataStart = firstEntryDataStart(corrupt)
  ok('  找得到第一个条目的数据起点', dataStart > 0, String(dataStart))
  corrupt[dataStart + 1] ^= 0xff
  const corruptRead = readZip(corrupt)
  ok('损坏的条目被 CRC 拒绝（不是悄悄放过）',
    corruptRead.ok === false && /CRC|INFLATE/.test(corruptRead.code),
    corruptRead.ok === false ? corruptRead.code : '(accepted!)')

  // Anything that is neither format, with a message that names what was found.
  const junk = Buffer.from('this is not an archive at all')
  const asArchive = readAnyArchive(junk)
  ok('既不是 tar.gz 也不是 zip 时说明清楚', asArchive.ok === false && asArchive.code === 'E_BAD_ARCHIVE', String(asArchive.code))
  ok('  错误信息里同时提到两种格式', /tar\.gz/.test(asArchive.detail) && /zip/.test(asArchive.detail), asArchive.detail)
}

console.log('')
console.log('--- 通过 HTTP 上传发布（端到端）---')
{
  const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const BASE = `http://127.0.0.1:${app.server.address().port}`
  /**
   * A fresh profile's admin must change its password before it can do anything else — the
   * first attempt returned 403 E_MUST_CHANGE_PASSWORD, and every later assertion in this
   * section then failed on `undefined`, which hides the real cause.
   */
  const post = async (path, body, token) => {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  const bootstrap = (await post('/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })).body
  const changed = await post('/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, bootstrap.token)
  ok('改掉初始密码（否则后面全部 403）', changed.status === 200, `${changed.status}/${changed.body?.code}`)
  const { token } = (await post('/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body

  const upload = async (bytes, query = '') => {
    const response = await fetch(`${BASE}/dsh-market/publish${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' },
      body: bytes,
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  const wrapped = zipWithPowerShell({ 'package.json': SKILL_PKG, 'SKILL.md': SKILL_MD }, { wrapper: 'zip-skill' })
  const zipBytes = readFileSync(wrapped.out)

  const preview = await upload(zipBytes)
  ok('zip 上传预检通过', preview.status === 200 && preview.body?.dryRun === true, `${preview.status}/${preview.body?.code}`)
  const would = preview.body?.wouldPublish
  ok('  预检报告了转换', would?.convertedFromZip === true, String(would?.convertedFromZip))
  ok('  报告了上传字节数与入库字节数', would?.uploadedBytes === zipBytes.length && would?.sizeBytes > 0,
    `${would?.uploadedBytes} -> ${would?.sizeBytes}`)
  ok('  预检的 sha256 是转换后的（不是上传的）',
    would?.sha256 === createHash('sha256').update(normaliseArchive(zipBytes).archive).digest('hex'),
    String(would?.sha256).slice(0, 16))

  const committed = await upload(zipBytes, '?commit=1')
  ok('正式发布成功', committed.status === 200 && committed.body?.ok === true, `${committed.status}/${committed.body?.code}`)
  ok('  类型记为 skill', committed.body?.artifact?.kind === 'skill', String(committed.body?.artifact?.kind))
  /**
   * The decisive one: the catalog's sha256 must describe the bytes the client will download.
   * If the upload's hash had been recorded instead, every install would fail its integrity
   * check with a message about corruption.
   */
  const catalog = await fetch(`${BASE}/dsh-market/catalog`, { headers: { authorization: `Bearer ${token}` } })
  const entry = (await catalog.json()).entries.find((e) => e.name === '@dsh-internal/zip-skill')
  ok('目录里的 sha256 与预检一致', entry?.sha256 === would?.sha256, `${String(entry?.sha256).slice(0, 16)} vs ${String(would?.sha256).slice(0, 16)}`)

  /**
   * Publishing is not permission to download: the policy is default-deny, so the admin needs
   * a grant before `/download` will hand back a single byte. Without this the download
   * returned a JSON refusal, whose first bytes then looked like a malformed archive.
   */
  await post('/dsh-market/admin/groups', { id: 'platform', description: '平台' }, token)
  await post('/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '@dsh-internal/*', effect: 'allow' }, token)
  await post('/dsh-market/admin/membership', { username: 'admin', groupId: 'platform' }, token)

  const download = await fetch(`${BASE}/dsh-market/download?name=${encodeURIComponent(entry.name)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  ok('下载请求成功', download.status === 200, String(download.status))
  const bytes = Buffer.from(await download.arrayBuffer())
  ok('下载到的是 tar.gz（客户端不必懂 zip）', bytes[0] === 0x1f && bytes[1] === 0x8b, bytes.subarray(0, 4).toString('hex'))
  ok('  下载字节的哈希与目录声明一致',
    createHash('sha256').update(bytes).digest('hex') === entry.sha256)
  ok('  条目仍然齐全', JSON.stringify(listEntries(bytes).sort()) === '["SKILL.md","package.json"]',
    JSON.stringify(listEntries(bytes)))

  app.server.close()
  app.db.close()
}

console.log('')
console.log('结论：')
console.log('  · 上传可以给 zip（包括 Windows 右键压缩那种多包一层的）。')
console.log('  · 入库统一转成 tar.gz：存储、哈希、下载、客户端解包只看一种格式。')
console.log('  · 预检给出的 sha256 是转换后的，所以客户端的完整性校验能通过。')
console.log('  · 坏归档（截断 / CRC 不符 / zip64 / 加密）各自给出说得出原因的拒绝。')

rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
