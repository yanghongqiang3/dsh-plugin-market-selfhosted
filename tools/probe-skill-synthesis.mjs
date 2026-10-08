/**
 * A skill bundle that is nothing but a `SKILL.md`.
 *
 * That is the format the ecosystem uses; demanding a stub `package.json` beside it was THIS
 * market's requirement, and it produced a dead end: a publisher zipped their skill, chose it,
 * and got 「归档内没有 package.json」 — a message about a file they had no reason to expect.
 *
 * So the service synthesises the manifest instead. Two of its fields cannot be read off the
 * frontmatter and are therefore explicit, and this probe pins why:
 *
 *  - **scope**: permission rules match on the package name, so `@dsh-internal/*` never matches
 *    a bare `my-skill`. Getting this wrong produces a perfectly published artifact that
 *    nobody can see.
 *  - **version**: updates are compared by version, so a bundle that never declares one can be
 *    published but never looks newer than what is installed.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'
import { inspectArchive, normaliseArchive, synthesiseSkillManifest } from '../server/lib/pack.js'
import { listEntries } from '../server/lib/pack.js'

const work = mkdtempSync(join(tmpdir(), 'dsh-synth-'))
let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

/** A real zip of a skill folder, via Compress-Archive. */
function zipSkill(frontmatter, { wrapper = 'my-skill', extra = {} } = {}) {
  const root = wrapper === null ? join(work, `flat-${Math.random().toString(36).slice(2, 7)}`) : join(work, wrapper)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), frontmatter)
  for (const [rel, content] of Object.entries(extra)) {
    const target = join(root, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  const out = join(work, `s-${Math.random().toString(36).slice(2, 8)}.zip`)
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${root}' -DestinationPath '${out}' -Force`], { stdio: 'ignore' })
  return { bytes: readFileSync(out), root }
}

const GOOD = '---\nname: release-checklist\ndescription: 发布前检查清单。\n---\n\n步骤一：确认版本号。\n'

console.log('--- 合成：把没有的 manifest 补出来 ---')
{
  const entries = new Map([
    ['my-skill/SKILL.md', Buffer.from('---\nname: my-check\ndescription: 说明。\n---\n\n正文\n')],
    ['my-skill/references/a.md', Buffer.from('# a\n')],
  ])
  const made = synthesiseSkillManifest(entries)
  ok('识别为技能包', made !== null && made.ok === true, made === null ? 'null' : String(made.code))
  ok('  名字取自 frontmatter', made.ok && made.manifest.name === 'my-check', String(made.manifest?.name))
  ok('  版本默认 0.1.0', made.ok && made.manifest.version === '0.1.0', String(made.manifest?.version))
  ok('  kind 强制为 skill', made.ok && made.manifest.dsh.market.kind === 'skill', String(made.manifest?.dsh.market.kind))
  ok('  摘要沿用 description', made.ok && made.manifest.dsh.market.summary === '说明。')
  // Injected at the bundle root, inside the wrapper, so a later strip lands it correctly.
  ok('  package.json 补在包装层内', made.ok && made.entries.has('my-skill/package.json'),
    JSON.stringify([...made.entries.keys()]))

  // Nothing skill-like: hand back null so the caller keeps its own complaint.
  ok('既无 SKILL.md 也无 manifest 时返回 null',
    synthesiseSkillManifest(new Map([['readme.txt', Buffer.from('x')]])) === null)
  // Two different wrappers each with a SKILL.md is ambiguous.
  ok('两个不同包装层各有一个 SKILL.md 时返回 null',
    synthesiseSkillManifest(new Map([
      ['a/SKILL.md', Buffer.from(GOOD)],
      ['b/SKILL.md', Buffer.from(GOOD)],
    ])) === null)
  // Deeper nesting is not a bundle root.
  ok('嵌套过深时返回 null',
    synthesiseSkillManifest(new Map([['a/b/SKILL.md', Buffer.from(GOOD)]])) === null)
}

console.log('')
console.log('--- 名字与版本的三种来源 ---')
{
  const entries = () => new Map([['SKILL.md', Buffer.from(
    '---\nname: from-frontmatter\ndescription: d\nversion: 2.3.4\n---\n\nb\n')]])
  const withFrontmatterVersion = synthesiseSkillManifest(entries())
  ok('frontmatter 的 version 优先于默认值',
    withFrontmatterVersion.ok && withFrontmatterVersion.manifest.version === '2.3.4',
    String(withFrontmatterVersion.manifest?.version))
  const overridden = synthesiseSkillManifest(entries(), { name: '@dsh-internal/other', version: '9.9.9' })
  ok('显式参数覆盖 frontmatter',
    overridden.ok && overridden.manifest.name === '@dsh-internal/other' && overridden.manifest.version === '9.9.9',
    `${overridden.manifest?.name}@${overridden.manifest?.version}`)
  // A name that cannot be a package name must be refused, not silently mangled.
  const badName = synthesiseSkillManifest(entries(), { name: 'Not A Name' })
  ok('非法包名被拒', badName.ok === false && badName.code === 'E_BAD_NAME', String(badName.code))
  ok('  提示里说明了作用域的后果', /作用域|scope/.test(badName.detail ?? ''), String(badName.detail).slice(0, 60))
  const badVersion = synthesiseSkillManifest(entries(), { version: 'v1' })
  ok('非法版本被拒', badVersion.ok === false && badVersion.code === 'E_BAD_VERSION', String(badVersion.code))
  const noFront = synthesiseSkillManifest(new Map([['SKILL.md', Buffer.from('没有 frontmatter\n')]]))
  ok('没有 frontmatter 被拒，且说明这是技能包',
    noFront.ok === false && noFront.code === 'E_SKILL_BAD_FRONTMATTER' && /技能包/.test(noFront.detail),
    String(noFront.detail).slice(0, 50))
}

console.log('')
console.log('--- 归一化整条链：只有 SKILL.md 的 zip ---')
{
  const { bytes } = zipSkill(GOOD, { extra: { 'references/notes.md': '# n\n' } })
  const normalised = normaliseArchive(bytes)
  ok('归一化成功', normalised.ok === true, String(normalised.code))
  ok('  报告了合成', normalised.ok && normalised.synthesis !== null, JSON.stringify(normalised.synthesis)?.slice(0, 60))
  ok('  存的是扁平 tar.gz', normalised.ok && normalised.archive[0] === 0x1f && normalised.archive[1] === 0x8b)
  ok('  包装层被剥掉并补上了 manifest',
    JSON.stringify(listEntries(normalised.archive).sort()) === '["SKILL.md","package.json","references/notes.md"]',
    JSON.stringify(listEntries(normalised.archive)))
  // And what got stored passes the ordinary inspection, i.e. it is a normal skill artifact.
  const inspection = inspectArchive(normalised.archive)
  ok('  入库后的归档通过常规校验', inspection.ok === true && inspection.kind === 'skill',
    `${inspection.code ?? ''} ${inspection.kind ?? ''}`.trim())
  ok('  再归一化一次是幂等的', normaliseArchive(normalised.archive).converted === false,
    String(normaliseArchive(normalised.archive).converted))
}

console.log('')
console.log('--- 端到端：上传、入库、可下载、客户端能装 ---')
{
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
  await post('/dsh-market/admin/groups', { id: 'platform', description: '平台' }, token)
  await post('/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '@dsh-internal/*', effect: 'allow' }, token)
  await post('/dsh-market/admin/membership', { username: 'admin', groupId: 'platform' }, token)

  const upload = async (bytes, query = '') => {
    const response = await fetch(`${BASE}/dsh-market/publish${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
      body: bytes,
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  const { bytes } = zipSkill(GOOD)
  const scoped = '?name=' + encodeURIComponent('@dsh-internal/release-checklist') + '&version=1.0.0'
  const preview = await upload(bytes, scoped)
  ok('预检通过', preview.status === 200, `${preview.status}/${preview.body?.code}`)
  const would = preview.body?.wouldPublish
  ok('  报告了补出的 manifest', would?.synthesised?.manifest?.name === '@dsh-internal/release-checklist',
    JSON.stringify(would?.synthesised?.manifest ?? null).slice(0, 80))
  ok('  用的是指定的作用域与版本', would?.name === '@dsh-internal/release-checklist' && would?.version === '1.0.0',
    `${would?.name}@${would?.version}`)
  ok('  kind 是 skill', would?.kind === 'skill', String(would?.kind))

  const committed = await upload(bytes, `${scoped}&commit=1`)
  ok('正式发布成功', committed.status === 200 && committed.body?.ok === true, `${committed.status}/${committed.body?.code}`)

  const catalog = await (await fetch(`${BASE}/dsh-market/catalog`, { headers: { authorization: `Bearer ${token}` } })).json()
  const entry = catalog.entries.find((e) => e.name === '@dsh-internal/release-checklist')
  ok('出现在目录里', entry !== undefined, JSON.stringify(catalog.entries.map((e) => e.name)))
  /**
   * The property that makes the scope worth asking for: a grant written `@dsh-internal/*`
   * matches it. A synthesised BARE name would have been invisible to that rule.
   */
  ok('  作用域规则匹配到它（canInstall）', entry?.canInstall === true, `${entry?.canInstall}/${entry?.reason}`)
  ok('  目录里标为技能', entry?.kind === 'skill', String(entry?.kind))

  const download = await fetch(`${BASE}/dsh-market/download?name=${encodeURIComponent(entry.name)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const downloaded = Buffer.from(await download.arrayBuffer())
  ok('下载到的是扁平 tar.gz（含补出的 manifest）',
    downloaded[0] === 0x1f && JSON.stringify(listEntries(downloaded).sort()) === '["SKILL.md","package.json"]',
    JSON.stringify(listEntries(downloaded)))

  app.server.close()
  app.db.close()
}

console.log('')
console.log('结论：')
console.log('  · 只有 SKILL.md 的技能包可以直接发布，服务端按 frontmatter 补出 manifest。')
console.log('  · 包名与版本可覆盖——作用域决定权限规则能否匹配，版本决定客户端能否看出更新。')
console.log('  · 入库仍是「扁平 tar.gz + 根 package.json」这一种形状。')
console.log('  · 既无 SKILL.md 也无 manifest 时，错误信息会说明两者各自需要什么。')

rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
