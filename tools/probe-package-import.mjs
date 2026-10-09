/**
 * Does the PACKAGED copy actually import?
 *
 * Packing can succeed while producing a package that cannot run: the host row's imports
 * must all resolve from what the archive contains. This was not hypothetical — adding a
 * shared semver module for the self-update made `lib/plugin.js` import
 * `../server/lib/version.js`, the packer did not include it, and the result installed
 * cleanly and then failed with MODULE_NOT_FOUND. Nothing else in the suite looks at the
 * archive's import graph, because every other test loads the REPOSITORY copy, where the
 * file obviously exists.
 *
 * So: extract the built tarball to a scratch directory and import the host row the way
 * the loader does. Also assert the entries are under `package/`, because a flat archive
 * installs as a flat package and that failure is equally invisible from the repository.
 *
 *   node tools/probe-package-import.mjs [tarball]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readTarGz } from '../server/lib/pack.js'
import { extractTarGz } from '../lib/tar.js'

/**
 * The default archive is DERIVED from package.json, not written out.
 *
 * It was the literal `dsh-plugin-marketplace-0.1.0.tgz`, so the moment the version moved on,
 * this probe silently started checking the PREVIOUS build — the one file whose whole job is to
 * validate the current archive was validating a stale one. `pack-dist.mjs` had the same string
 * in a usage comment.
 */
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
const defaultArchive = resolve(import.meta.dirname, '..', 'dist', `${pkg.name}-${pkg.version}.tgz`)
const archivePath = resolve(process.argv[2] ?? defaultArchive)

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

if (!existsSync(archivePath)) {
  console.error(`找不到归档：${archivePath}`)
  console.error('先跑 `node tools/pack-dist.mjs`。')
  process.exit(1)
}

const bytes = readFileSync(archivePath)
const entries = [...readTarGz(bytes).keys()].sort()
ok('归档存在且可读', bytes.length > 0, `${bytes.length} B`)

// The npm layout, because a flat archive installs wrong even though it looks fine here.
const atRoot = entries.filter((entry) => !entry.startsWith('package/'))
ok('全部条目在 package/ 下', atRoot.length === 0, atRoot.slice(0, 3).join(', '))

// Every relative import in the host row and the client half must be present.
const localImports = (source) =>
  [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])
const has = (rel) => entries.includes(`package/${rel}`)

const work = mkdtempSync(join(tmpdir(), 'dsh-pkgimport-'))
try {
  extractTarGz(bytes, work, { stripPrefix: 'package/' })
  for (const file of ['lib/plugin.js', 'lib/client.js', 'lib/bundle.js']) {
    const full = join(work, file)
    ok(`归档内存在 ${file}`, existsSync(full))
    if (!existsSync(full)) continue
    for (const spec of localImports(readFileSync(full, 'utf8'))) {
      // Resolve the specifier relative to the importing file, the way Node would.
      const target = resolve(join(work, file), '..', spec)
      const rel = target.slice(work.length + 1).replace(/\\/g, '/')
      ok(`  ${file} 依赖的 ${spec} 在包里`, existsSync(target), has(rel) ? '' : '（归档里没有）')
    }
  }

  /**
   * The decisive check: import the extracted host row.
   *
   * A module graph that is only *listed* correctly still fails here if a specifier
   * resolves outside the package or a file is empty.
   */
  process.env.DSH_PROFILE_DIR = work
  process.env.MARKET_SERVICE_URL = 'http://127.0.0.1:1'
  process.env.MARKET_DIAG_LOG = join(work, 'diag.log')
  try {
    const module = await import(pathToFileURL(join(work, 'lib', 'plugin.js')).href)
    ok('装出来的宿主半边能被 import', typeof module.apply === 'function', `apply=${typeof module.apply}`)
    ok('  且导出 name', module.name === 'dsh-plugin-marketplace', String(module.name))
  } catch (error) {
    ok('装出来的宿主半边能被 import', false, String(error.message).split('\n')[0])
  }

  // The client half is a plain script, so it only has to parse.
  const clientSource = readFileSync(join(work, 'lib', 'client.js'), 'utf8')
  let clientParses = true
  let clientError = ''
  try {
    // eslint-disable-next-line no-new-func
    new Function(clientSource)
  } catch (error) {
    clientParses = false
    clientError = String(error.message)
  }
  ok('装出来的客户端半边语法正确', clientParses, clientError)

  // And the console must NOT be in there: it belongs to the service.
  ok('归档里没有 web/console.*', !entries.some((entry) => entry.includes('console.')))
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log('')
console.log('为什么要有这个检查：')
console.log('  · 其它测试都加载**仓库里**的那份，文件当然在，所以看不出打包器漏了什么。')
console.log('  · 这个工具解开真正的 tar.gz，再按 loader 的方式 import 一次。')

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
