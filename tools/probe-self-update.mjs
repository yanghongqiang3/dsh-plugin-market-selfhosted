/**
 * The market plugin's own auto-update, end to end.
 *
 * Claims to verify, rather than describe:
 *   1. a client running an older version adopts the package the service carries
 *   2. it does NOT do so silently when the install is a link (that path belongs to a
 *      working tree or to pnpm's store, and writing through it destroys the real source)
 *   3. it does nothing when versions match, and nothing when the service has no package
 *   4. the staged tree is complete and is the OFFERED version, not a partial extract
 *   5. MARKET_AUTO_UPDATE=0 disables it
 *
 * The plugin reads its profile and service URL from the environment at import time, so
 * this builds a throwaway profile and a throwaway service before loading it.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createApp } from '../server/index.mjs'
import { packTarGz } from '../server/lib/pack.js'

const REPO = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-selfupdate-'))

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

/** Build a package archive in the npm layout, with a given version and body marker. */
let buildCounter = 0
const buildPackage = (version, marker) => {
  buildCounter += 1
  const dir = join(work, `build-${buildCounter}-${version}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'package', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({
    name: 'dsh-plugin-market-internal',
    version,
    exports: { './client': './lib/client.js' },
  }, null, 2))
  writeFileSync(join(dir, 'package', 'cordis.patch.yml'), '# patch\n')
  writeFileSync(join(dir, 'package', 'lib', 'plugin.js'), `// ${marker}\nexport function apply() {}\nexport const name = 'x'\n`)
  writeFileSync(join(dir, 'package', 'lib', 'client.js'), `// ${marker}\n`)
  const entries = [
    'package/package.json',
    'package/cordis.patch.yml',
    'package/lib/plugin.js',
    'package/lib/client.js',
  ]
  return { archive: packTarGz(dir, entries), entries }
}

/** Install a version into a profile as a REAL directory (not a link). */
const installReal = (profileDir, version, marker) => {
  const target = join(profileDir, 'node_modules', 'dsh-plugin-market-internal')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(join(target, 'lib'), { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'dsh-plugin-market-internal', version }))
  writeFileSync(join(target, 'lib', 'plugin.js'), `// ${marker}\n`)
  writeFileSync(join(target, 'lib', 'client.js'), `// ${marker}\n`)
  return target
}

const makeProfile = (name) => {
  const profileDir = join(work, name)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dsh: { profile: { bundles: ['dsh-plugin-market-internal'], disabledBundles: [] } },
  }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '')
  return profileDir
}

// ------------------------------------------------------------------ the service
const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${app.server.address().port}`
process.env.MARKET_SERVICE_URL = BASE
process.env.MARKET_DIAG_LOG = join(work, 'diag.log')

const v2 = buildPackage('2.0.0', 'SELF-UPDATE-2.0.0')
app.artifacts.stageMarketplacePackage(v2.archive)

/**
 * Load the plugin FRESH for each scenario.
 *
 * The module caches its profile location and service URL at import time, and Node caches
 * the module itself, so each scenario needs a distinct URL to get a real new instance.
 * Sharing one would silently test the first profile every time.
 */
let generation = 0
const loadPlugin = async (profileDir) => {
  process.env.DSH_PROFILE_DIR = profileDir
  process.env.DSH_HOME = work
  generation += 1
  const module = await import(`../lib/plugin.js?gen=${generation}`)
  const routes = []
  const ctx = {
    get: (name) => (name === 'webServer'
      ? { port: 65000 + generation, register: (route) => { routes.push(route); return () => {} } }
      : undefined),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  module.apply(ctx)
  // The self-update runs on its own schedule; give it room to finish.
  for (let i = 0; i < 80; i += 1) await new Promise((r) => setTimeout(r, 50))
  return { routes }
}

const versionAt = (target) => {
  try { return JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version } catch { return null }
}
const markerAt = (target) => {
  try { return readFileSync(join(target, 'lib', 'plugin.js'), 'utf8').trim() } catch { return null }
}
/** The version of THIS repository's package — what the loaded plugin actually reports. */
const runningVersionOfRepo = () =>
  JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version

// ------------------------------------------------------------------ 1. the更新 itself
console.log('--- 普通安装：应当自动升级 ---')
{
  const profileDir = makeProfile('plain')
  const target = installReal(profileDir, '1.0.0', 'OLD-1.0.0')
  await loadPlugin(profileDir)
  ok('升级到服务端提供的版本', versionAt(target) === '2.0.0', String(versionAt(target)))
  ok('文件内容是新的，不是旧版残留', String(markerAt(target)).includes('SELF-UPDATE-2.0.0'), String(markerAt(target)))
  ok('暂存目录已清理', !existsSync(`${target}.staging`))
  ok('旧版本目录已清理（不会每次升级留一个）', !existsSync(`${target}.previous`))

  const diag = readFileSync(join(work, 'diag.log'), 'utf8').split('\n').filter((l) => l.includes('self-update'))
  ok('诊断里有 staged 记录', diag.some((l) => l.includes('"status":"staged"')), diag.slice(-1)[0] ?? '')
}

// ------------------------------------------------------------------ 2. linked install
console.log('')
console.log('--- 链接安装：必须拒绝，否则会写穿到源目录 ---')
{
  const profileDir = makeProfile('linked')
  // A real source tree somewhere else, linked in — the development / pnpm layout.
  const source = join(work, 'source-tree')
  mkdirSync(join(source, 'lib'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-plugin-market-internal', version: '1.0.0' }))
  writeFileSync(join(source, 'lib', 'plugin.js'), '// SOURCE-MUST-SURVIVE\n')
  const target = join(profileDir, 'node_modules', 'dsh-plugin-market-internal')
  rmSync(target, { recursive: true, force: true })
  symlinkSync(source, target, 'junction')
  ok('前提：装的确实是链接', lstatSync(target).isSymbolicLink())

  await loadPlugin(profileDir)
  ok('链接安装没有被升级', versionAt(source) === '1.0.0', String(versionAt(source)))
  ok('源目录内容原样保留', String(markerAt(source)).includes('SOURCE-MUST-SURVIVE'), String(markerAt(source)))
  ok('链接本身还在（没有被替换成目录）', lstatSync(target).isSymbolicLink())
  const diag = readFileSync(join(work, 'diag.log'), 'utf8').split('\n').filter((l) => l.includes('self-update'))
  ok('诊断里记了 refused', diag.some((l) => l.includes('"status":"refused"')), diag.slice(-1)[0] ?? '')
}

// ------------------------------------------------------------------ 3. current and older
console.log('')
console.log('--- 服务端不更新（同版 / 更旧）：应当什么都不做 ---')
/**
 * `runningVersion()` reads the manifest of the package THIS module was loaded from, which
 * is the repository — not the throwaway profile. So a scenario "profile holds 2.0.0,
 * service offers 2.0.0" does not exercise "already current": the running version is still
 * 0.1.0 and the plugin correctly decides to update. The first version of this file
 * asserted on the profile's copy and failed for that reason, which is a failure of the
 * test's model rather than of the feature.
 *
 * What actually needs proving is the DECISION BOUNDARY, and that does not depend on which
 * version happens to be checked out: a service offering the same version, or an older
 * one, must leave the install untouched.
 */
for (const [label, offered] of [['同版', runningVersionOfRepo()], ['更旧', '0.0.1']]) {
  const staged = buildPackage(offered, `OFFERED-${offered}`)
  app.artifacts.stageMarketplacePackage(staged.archive)
  const profileDir = makeProfile(`nochange-${offered}`)
  const target = installReal(profileDir, '1.0.0', 'UNTOUCHED-1.0.0')
  const before = markerAt(target)
  await loadPlugin(profileDir)
  ok(`服务端提供${label}版本时不改动本机`, markerAt(target) === before, `${offered} -> ${String(markerAt(target))}`)
  const diag = readFileSync(join(work, 'diag.log'), 'utf8').split('\n').filter((l) => l.includes('self-update'))
  ok(`  诊断为 current`, diag.some((l) => l.includes('"status":"current"')), diag.slice(-1)[0] ?? '')
}

// ------------------------------------------------------------------ 4. nothing offered
console.log('')
console.log('--- 服务端没有放包：应当什么都不做 ---')
{
  app.artifacts.selfMetaFile // touch, no-op
  rmSync(join(work, 'storage', 'self'), { recursive: true, force: true })
  const profileDir = makeProfile('nooffer')
  const target = installReal(profileDir, '1.0.0', 'NOOFFER-1.0.0')
  await loadPlugin(profileDir)
  ok('没有包时不改动本机', versionAt(target) === '1.0.0', String(versionAt(target)))
  const diag = readFileSync(join(work, 'diag.log'), 'utf8').split('\n').filter((l) => l.includes('self-update'))
  ok('诊断里记了 skipped', diag.some((l) => l.includes('"status":"skipped"')), diag.slice(-1)[0] ?? '')
}

// ------------------------------------------------------------------ 5. the kill switch
console.log('')
console.log('--- MARKET_AUTO_UPDATE=0：应当完全不检查 ---')
{
  app.artifacts.stageMarketplacePackage(v2.archive)
  const profileDir = makeProfile('disabled')
  const target = installReal(profileDir, '1.0.0', 'DISABLED-1.0.0')
  process.env.MARKET_AUTO_UPDATE = '0'
  await loadPlugin(profileDir)
  delete process.env.MARKET_AUTO_UPDATE
  ok('开关关闭时不升级', versionAt(target) === '1.0.0', String(versionAt(target)))
  const diag = readFileSync(join(work, 'diag.log'), 'utf8').split('\n').filter((l) => l.includes('self-update'))
  ok('诊断里记了 disabled', diag.some((l) => l.includes('disabled by')), diag.slice(-1)[0] ?? '')
}

console.log('')
console.log('结论：')
console.log('  · 普通安装会在启动时自动取用服务端的包，下次启动生效。')
console.log('  · 链接安装（pnpm / 开发时的 junction）一律拒绝，不会写穿到源目录。')
console.log('  · 已是最新、服务端没放包、开关关闭 —— 三种情况都不动本机文件。')

app.server.close()
app.db.close()
rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
