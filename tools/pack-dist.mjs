/**
 * Pack this plugin into an installable tarball.
 *
 *   node tools/pack-dist.mjs [outFile]
 *
 * Produces a `.tar.gz` a DSH client installs with one command:
 *
 *   dsh plugin --profile <name> add ./dist/dsh-plugin-marketplace-0.1.0.tgz
 *
 * WHY THE `package/` PREFIX IS LOAD-BEARING
 *
 * An npm tarball must place every entry under a single `package/` directory; that is
 * the convention npm and pnpm use to find the package root. Verified on this machine,
 * both ways:
 *
 *   entries at the root (`lib/plugin.js`)
 *     -> pnpm installs `plugin.js` at the package root. The `lib/` segment is LOST,
 *        package.json's `exports` point at files that do not exist, and both loader
 *        rows fail with `failed to import`.
 *   entries under `package/` (`package/lib/plugin.js`)
 *     -> correct layout, both rows activate, the sidebar entry renders.
 *
 * So the archive is built from a STAGING directory whose only child is `package/`,
 * rather than by prefixing entry names, because the packer reads paths relative to its
 * root and would not find a prefixed path there.
 *
 * This is a DIFFERENT format from the market's stored artifacts: those are flat
 * (root-level `package.json`, no prefix), because `server/lib/pack.js` reads
 * `package.json` at the archive root. Keep the two apart — see `docs/distributing.md`.
 */
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, cpSync, rmSync, statSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packTarGz } from '../server/lib/pack.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/**
 * Everything a client needs, and nothing that only matters while developing here.
 *
 * `INCLUDE_FILES` covers single files outside the main trees. `server/lib/version.js` is
 * here because `lib/plugin.js` imports it: the semver comparison has to be the SAME code
 * the service uses, since the client decides whether the service carries a newer copy of
 * this plugin. Leaving it out produced a package that installed cleanly and then failed
 * to import with MODULE_NOT_FOUND — caught by `tools/probe-package-import.mjs`, which
 * imports the packaged copy the way the loader does.
 */
const INCLUDE = ['package.json', 'cordis.patch.yml', 'README.md', 'lib', 'web', 'docs']
const INCLUDE_FILES = ['server/lib/version.js', 'server/lib/layout.js']
const SKIP = new Set(['node_modules', '.git', '.market', 'preview', '.research'])

/**
 * Console files stay OUT of the client package.
 *
 * The console is the SERVICE's page: `server/lib/http.js` reads it from its own `web/`
 * directory and serves it at `/console`. The client plugin never reads it — its asset
 * whitelist (`PAGE_ASSETS` in `lib/plugin.js`) deliberately omits both files, and a test
 * holds that line by asserting `console.css` 404s through the plugin's route.
 *
 * Verified with `tools/probe-console-source.mjs`: a marker written into a copy of the
 * service tree's `console.html` is returned verbatim by that service's `/console`. So
 * editing the console needs a SERVICE restart, never a plugin repack.
 *
 * Shipping a copy anyway would be dead weight with a nasty failure mode: deploy the
 * service from inside an installed package and it serves a FROZEN console snapshot that
 * no repo edit reaches. This is also why I once told the user that a console change
 * required repacking — the copy made that look plausible. It was wrong.
 */
const EXCLUDE = new Set(['web/console.html', 'web/console.css'])

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const out = resolve(process.argv[2] ?? join(ROOT, 'dist', `${pkg.name}-${pkg.version}.tgz`))

const stage = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
try {
  const inner = join(stage, 'package')
  mkdirSync(inner, { recursive: true })

  for (const item of INCLUDE) {
    const from = join(ROOT, item)
    let st
    try { st = statSync(from) } catch { continue }
    const to = join(inner, item)
    if (st.isDirectory()) {
      // `filter` runs per entry; dropping by relative path keeps `node_modules` and the
      // console files out at any depth without walking the tree twice.
      cpSync(from, to, {
        recursive: true,
        filter: (src) => {
          const rel = src.slice(ROOT.length + 1).replace(/[\\/]/g, '/')
          if (SKIP.has(rel.split('/').pop())) return false
          return !EXCLUDE.has(rel)
        },
      })
    } else {
      if (EXCLUDE.has(item)) continue
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
  for (const item of INCLUDE_FILES) {
    const from = join(ROOT, item)
    if (!existsSync(from)) throw new Error(`missing required file: ${item}`)
    const to = join(inner, item)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }

  // Enumerate what actually landed in the staging tree, so the archive can never list
  // a file the copy step skipped.
  const entries = []
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if (statSync(join(dir, name)).isDirectory()) walk(join(dir, name), rel)
      else entries.push(rel)
    }
  }
  walk(stage, '')

  const atRoot = entries.filter((entry) => !entry.startsWith('package/'))
  if (atRoot.length > 0) {
    throw new Error(`staging tree has entries outside package/: ${atRoot.join(', ')}`)
  }
  // A silent exclusion list is how a file goes missing for months. Assert instead.
  const leaked = entries.filter((entry) => EXCLUDE.has(entry.replace(/^package\//, '')))
  if (leaked.length > 0) {
    throw new Error(`excluded files leaked into the archive: ${leaked.join(', ')}`)
  }

  const archive = packTarGz(stage, entries)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, archive)

  console.log(`${pkg.name}@${pkg.version}`)
  console.log(`  文件      ${entries.length} 个（全部在 package/ 下）`)
  console.log(`  已排除    ${[...EXCLUDE].join('、')}（服务端的页面，本机插件不读）`)
  console.log(`  归档      ${out}`)
  console.log(`  大小      ${archive.length} B`)
  console.log('')
  console.log('安装到某个 profile：')
  console.log(`  dsh plugin --profile <name> add "${out}"`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
