/**
 * What does the catalog call "the latest version"?
 *
 * The install page decides whether to offer 「更新到 X」 by comparing the catalog's
 * `version` with the installed one, so this ordering IS the update mechanism. Reading
 * the code says `ORDER BY published_at DESC` — most recently PUBLISHED, which is not the
 * same as the highest version. Whether that is a real defect depends on what actually
 * happens when versions arrive out of order, so measure it.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-version-'))
const app = createApp({ dbFile: join(workDir, 'market.db'), storageDir: join(workDir, 'storage') })

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

/** Publish a package with a given version and a distinct body byte. */
const publish = (version, state = 'published') => {
  const dir = join(workDir, `pkg-${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@dsh-internal/dsh-plugin-demo', version }))
  writeFileSync(join(dir, 'index.js'), `// ${version}\n`)
  writeFileSync(join(dir, 'market.json'), JSON.stringify({ state, summary: `demo ${version}` }))
  return app.artifacts.publishFromDirectory(dir, { state, publishedBy: 'alice' })
}

// Publish in an order a human would not: newest first, then older ones.
publish('2.0.0')
await new Promise((r) => setTimeout(r, 15))
publish('1.5.0')
await new Promise((r) => setTimeout(r, 15))
publish('1.0.0')

const rows = app.artifacts.catalogRows()
const row = rows.find((r) => r.name === '@dsh-internal/dsh-plugin-demo')
console.log(`  发布的顺序: 2.0.0 -> 1.5.0 -> 1.0.0`)
console.log(`  catalog 报的版本: ${row?.version}`)
console.log('')

ok(
  'catalog 报的是最高版本，而不是最近发布的',
  row?.version === '2.0.0',
  row?.version === '2.0.0' ? '' : `报成了 ${row?.version}（最近发布的），会诱导客户端「更新」到更旧的版本`,
)

// Same question for `latest`, which the download route uses when no version is pinned.
const latest = app.artifacts.latest('@dsh-internal/dsh-plugin-demo')
console.log(`  latest(): ${latest?.version}`)
ok(
  'latest() 返回最高版本',
  latest?.version === '2.0.0',
  latest?.version === '2.0.0' ? '' : `返回了 ${latest?.version}`,
)

// And what a pinned download resolves to — the part that must be exact.
const pinned = app.artifacts.get('@dsh-internal/dsh-plugin-demo', '1.5.0')
ok('按版本取是精确的', pinned?.version === '1.5.0', String(pinned?.version))

// All three versions must be listable, or an update cannot be audited.
const all = app.artifacts.listVersions('@dsh-internal/dsh-plugin-demo').map((a) => a.version)
ok('三个版本都在库里', all.length === 3, JSON.stringify(all))

// ------------------------------------------------------------------ state matters
/**
 * A revoked newest version must NOT be reported as latest.
 *
 * `policy` refuses it with E_REVOKED, but the catalog is built first — so the old query
 * showed an 「更新到 2.0.0」 button whose every click failed. Withdrawing a release has
 * to fall back to the previous good one, not advertise the withdrawn one.
 */
app.artifacts.setState('@dsh-internal/dsh-plugin-demo', '2.0.0', 'stable', 'revoked')
const afterRevoke = app.artifacts.catalogRows().find((r) => r.name === '@dsh-internal/dsh-plugin-demo')
ok('撤回最高版本后，catalog 回落到上一可用版本', afterRevoke?.version === '1.5.0', String(afterRevoke?.version))
ok('latest() 同样回落到 1.5.0', app.artifacts.latest('@dsh-internal/dsh-plugin-demo')?.version === '1.5.0')

// A version still under review is not installable either, so it must not be offered.
publish('3.0.0', 'review')
const afterReview = app.artifacts.catalogRows().find((r) => r.name === '@dsh-internal/dsh-plugin-demo')
ok('待审的 3.0.0 不会被当成最新', afterReview?.version === '1.5.0', String(afterReview?.version))

// Restoring it brings it back — the fallback must not be a one-way door.
app.artifacts.setState('@dsh-internal/dsh-plugin-demo', '2.0.0', 'stable', 'published')
ok('恢复 published 后 2.0.0 重新成为最新', app.artifacts.catalogRows().find((r) => r.name === '@dsh-internal/dsh-plugin-demo')?.version === '2.0.0')

// ------------------------------------------------------------------ ordering rules
/**
 * The ordering rules that make "highest" mean what a human expects. Each of these used
 * to be decided by `published_at`, so every one of them was effectively random.
 */
const { compareVersions, parseVersion } = await import('../server/lib/artifacts.js')
const ordered = (list) => [...list].sort(compareVersions)
ok('1.10.0 > 1.9.0（数字比较，不是字符串）', compareVersions('1.10.0', '1.9.0') > 0)
ok('0.2.10 > 0.2.9', compareVersions('0.2.10', '0.2.9') > 0)
ok('2.0.0 > 1.99.99', compareVersions('2.0.0', '1.99.99') > 0)
ok('正式版高于其预发布版（1.0.0 > 1.0.0-rc.1）', compareVersions('1.0.0', '1.0.0-rc.1') > 0)
ok('rc.2 > rc.1', compareVersions('1.0.0-rc.2', '1.0.0-rc.1') > 0)
ok('rc.10 > rc.9', compareVersions('1.0.0-rc.10', '1.0.0-rc.9') > 0)
ok('alpha.1 > alpha（更长的预发布列表更大）', compareVersions('1.0.0-alpha.1', '1.0.0-alpha') > 0)
ok('alpha < alpha.1 < beta < rc < 正式', JSON.stringify(ordered(['1.0.0', '1.0.0-rc.1', '1.0.0-beta', '1.0.0-alpha.1', '1.0.0-alpha'])) === JSON.stringify(['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-rc.1', '1.0.0']))
ok('构建元数据不参与排序（1.0.0+a == 1.0.0+b）', compareVersions('1.0.0+a', '1.0.0+b') === 0)
ok('非 semver 版本被识别为不可解析', parseVersion('v1.0') === null && parseVersion('1.0') === null && parseVersion('2024-01-05') === null)
// And publishing one is refused at the boundary rather than degrading the catalog.
{
  const dir = join(workDir, 'pkg-badversion')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@dsh-internal/dsh-plugin-bad', version: '1.0' }))
  let refused = false
  try { app.artifacts.publishFromDirectory(dir, { publishedBy: 'alice' }) } catch { refused = true }
  ok('非 semver 版本在发布时就被拒绝', refused)
}

console.log('')
console.log('结论：')
console.log(problems === 0
  ? '  · catalog / latest 按语义版本取最高的「可发布」版本，更新按钮指向真正的最新版。'
  : '  · 版本选择仍有问题。')
console.log('  · 「更新」= catalog 里的 version 与本机已装版本不同；没有单独的 update 接口。')
console.log('  · revoked / 待审版本不参与「最新」的选举，所以不会出现点了必然失败的更新按钮。')

app.db.close()
rmSync(workDir, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
