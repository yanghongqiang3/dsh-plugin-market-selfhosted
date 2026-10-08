/**
 * The service records WHAT an artifact is, and refuses a skill it cannot deliver.
 *
 * Before this, `dsh.market.kind` existed only inside each package.json: the console could
 * not label an artifact, and a skill bundle with no `SKILL.md` published cleanly, appeared
 * in the catalog, and failed only at the last step — on someone else's machine.
 *
 * The two publish paths must also agree. They did not: `publishFromDirectory` (the CLI)
 * skipped `inspectArchive` entirely, so it was STRICTER on upload than on disk, and a
 * bundle missing its declared `dsh.bundle.patch` could be published from a directory and
 * refused as an upload.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'
import { inspectArchive, packTarGz } from '../server/lib/pack.js'

const work = mkdtempSync(join(tmpdir(), 'dsh-kind-'))
const profileDir = join(work, 'profile')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })

/** Build a package directory on disk and return its path. */
const makeDir = (name, files) => {
  const dir = join(work, `src-${name.replace(/[@/]/g, '_')}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}
const packDir = (dir, entries) => packTarGz(dir, entries)
const frontmatter = (name, extra = '') => `---\nname: ${name}\ndescription: 说明。\n${extra}---\n\n正文。\n`

console.log('--- kind 被正确识别 ---')
{
  const cases = [
    ['插件（没有任何 dsh.market.kind）', { name: 'p1', version: '1.0.0' }, 'plugin'],
    ['组合包（有 dsh.bundle.patch）', { name: 'b1', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }, 'bundle'],
    ['技能（kind=skill）', { name: 's1', version: '1.0.0', dsh: { market: { kind: 'skill' } } }, 'skill'],
  ]
  for (const [label, pkg, expected] of cases) {
    const files = { 'package.json': JSON.stringify(pkg) }
    const entries = ['package.json']
    if (expected === 'bundle') { files['cordis.patch.yml'] = '- name: x\n'; entries.push('cordis.patch.yml') }
    if (expected === 'skill') { files['SKILL.md'] = frontmatter('s1'); entries.push('SKILL.md') }
    const dir = makeDir(pkg.name, files)
    const inspection = inspectArchive(packDir(dir, entries))
    ok(`${label} -> ${expected}`, inspection.ok && inspection.kind === expected, `${inspection.code ?? ''}${inspection.kind ?? ''}`)
  }
}

console.log('')
console.log('--- 发布时就拒绝残缺的技能（不再等到安装）---')
{
  const bad = [
    ['没有 SKILL.md', { 'package.json': JSON.stringify({ name: 's2', version: '1.0.0', dsh: { market: { kind: 'skill' } } }) }, 'package.json', 'E_SKILL_MISSING'],
    ['frontmatter 缺 description', {
      'package.json': JSON.stringify({ name: 's3', version: '1.0.0', dsh: { market: { kind: 'skill' } } }),
      'SKILL.md': '---\nname: s3\n---\n正文\n',
    }, null, 'E_SKILL_BAD_FRONTMATTER'],
    ['name 不是 kebab-case', {
      'package.json': JSON.stringify({ name: 's4', version: '1.0.0', dsh: { market: { kind: 'skill' } } }),
      'SKILL.md': frontmatter('Not_Kebab'),
    }, null, 'E_SKILL_BAD_NAME'],
    ['根本没有 frontmatter', {
      'package.json': JSON.stringify({ name: 's5', version: '1.0.0', dsh: { market: { kind: 'skill' } } }),
      'SKILL.md': '正文但没有 frontmatter\n',
    }, null, 'E_SKILL_BAD_FRONTMATTER'],
  ]
  for (const [label, files, , expected] of bad) {
    const entries = Object.keys(files)
    const dir = makeDir(files['package.json'] ? JSON.parse(files['package.json']).name : 'x', files)
    const inspection = inspectArchive(packDir(dir, entries))
    ok(`${label} -> 拒绝`, inspection.ok === false && inspection.code === expected, `${inspection.code ?? '(accepted!)'}`)
  }
}

console.log('')
console.log('--- 两条发布路径必须一致 ---')
{
  /**
   * The directory path used to skip inspection, so this package published from disk and was
   * refused as an upload. Whichever way it is published, the answer must be the same.
   */
  const files = {
    'package.json': JSON.stringify({ name: 'b2', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
  }
  const dir = makeDir('b2', files)
  let dirError = null
  try { app.artifacts.publishFromDirectory(dir, { publishedBy: 'tester' }) } catch (error) { dirError = error }
  ok('目录路径也校验 dsh.bundle.patch', dirError?.code === 'E_BUNDLE_PATCH_MISSING', String(dirError?.code))

  let uploadError = null
  try { app.artifacts.publishArchive(packDir(dir, ['package.json']), { publishedBy: 'tester' }) } catch (error) { uploadError = error }
  ok('  上传路径给出同一个错误码', uploadError?.code === dirError?.code, `${uploadError?.code} vs ${dirError?.code}`)
}

console.log('')
console.log('--- kind 入库并可读出 ---')
{
  const dir = makeDir('skill-good', {
    'package.json': JSON.stringify({
      name: '@dsh-internal/skill-good', version: '1.2.0', dsh: { market: { kind: 'skill', owner: 'platform' } },
    }),
    'SKILL.md': frontmatter('good-skill', 'whenToUse: 需要时\n'),
    'references/n.md': '# n\n',
  })
  const saved = app.artifacts.publishFromDirectory(dir, { publishedBy: 'tester', state: 'published' })
  ok('技能发布成功', saved?.name === '@dsh-internal/skill-good', String(saved?.name))
  ok('  kind 记为 skill', saved?.kind === 'skill', String(saved?.kind))
  // Round-trip through the DB, not just the returned object: the column is the point.
  const reread = app.artifacts.get('@dsh-internal/skill-good', '1.2.0', 'stable')
  ok('  从库里读回来仍是 skill', reread?.kind === 'skill', String(reread?.kind))
  const catalog = app.artifacts.catalogRows()
  const row = catalog.find((entry) => entry.name === '@dsh-internal/skill-good')
  ok('  目录里也带 kind（控制台据此标注）', row?.kind === 'skill', String(row?.kind))

  // A plugin keeps its own label rather than inheriting the skill default.
  const pluginDir = makeDir('plugin-plain', {
    'package.json': JSON.stringify({ name: '@dsh-internal/plugin-plain', version: '1.0.0' }),
    'lib/plugin.js': 'export function apply() {}\n',
  })
  const plugin = app.artifacts.publishFromDirectory(pluginDir, { publishedBy: 'tester' })
  ok('普通插件记为 plugin', plugin?.kind === 'plugin', String(plugin?.kind))
}

console.log('')
console.log('--- 迁移：旧库里没有 kind 列 ---')
{
  /**
   * `CREATE TABLE IF NOT EXISTS` does nothing to an existing table, so a database made
   * before this change has no `kind` column. The migration must add it AND existing rows
   * must read back as a usable value rather than undefined.
   */
  const legacy = join(work, 'legacy.db')
  const first = createApp({ dbFile: legacy, storageDir: join(work, 'legacy-storage') })
  const dir = makeDir('legacy-pkg', {
    'package.json': JSON.stringify({ name: '@dsh-internal/legacy-pkg', version: '1.0.0' }),
    'lib/plugin.js': 'export function apply() {}\n',
  })
  first.artifacts.publishFromDirectory(dir, { publishedBy: 'tester' })
  first.db.exec('ALTER TABLE artifacts DROP COLUMN kind')
  first.db.close()
  // Re-open: the migration must notice the missing column and add it.
  const second = createApp({ dbFile: legacy, storageDir: join(work, 'legacy-storage') })
  const columns = second.db.prepare('PRAGMA table_info(artifacts)').all()
  ok('重开后补上了 kind 列', columns.some((row) => row.name === 'kind'))
  const recovered = second.artifacts.get('@dsh-internal/legacy-pkg', '1.0.0', 'stable')
  ok('  旧行读得出一个可用的类型', recovered?.kind === 'plugin', String(recovered?.kind))
  second.server.close()
  second.db.close()
}

console.log('')
console.log('结论：')
console.log('  · 服务端在发布时记录 plugin / bundle / skill，控制台据此标注与筛选。')
console.log('  · 技能缺 SKILL.md、frontmatter 残缺或名字非法，一律在发布时拒绝。')
console.log('  · CLI 目录路径与上传路径走同一套校验（此前不一致）。')
console.log('  · 旧数据库开机会补上 kind 列，旧行按 plugin 读出。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
