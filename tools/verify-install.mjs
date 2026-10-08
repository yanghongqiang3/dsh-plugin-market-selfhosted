// Pre-flight check for the marketplace install.
//
// The architecture is a bundle whose patch layer inserts ONE behavioural host
// row; the browser half is a page served by that row, not a DSH client plugin.
// This script verifies exactly that, plus the served page.
//
//   node tools/verify-install.mjs <profileDir>
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const profileDir =
  process.argv[2] ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop')

const PKG = 'dsh-plugin-marketplace'

let problems = 0
const fail = (message) => (problems += 1, console.error(`FAIL  ${message}`))
const ok = (message) => console.log(`ok    ${message}`)

/** `exports` values are a string, or a conditions object like { default: "./x.js" }. */
function targetOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const key of ['default', 'import', 'node', 'require']) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return null
}

if (!fs.existsSync(profileDir)) {
  fail(`profile directory not found: ${profileDir}`)
  process.exit(1)
}
console.log(`profile: ${profileDir}\n`)

const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
const bundles = manifest?.dsh?.profile?.bundles ?? []
const req = createRequire(path.join(profileDir, 'noop.js'))

function resolveSpec(spec) {
  try {
    const resolved = req.resolve(spec)
    ok(`require.resolve("${spec}") -> ${resolved}`)
  } catch (error) {
    fail(`require.resolve("${spec}") failed: ${error.message.split('\n')[0]}`)
  }
}

console.log(`--- ${PKG} ---`)
if (!bundles.includes(PKG)) fail(`"${PKG}" is not listed in dsh.profile.bundles`)
else ok('listed in dsh.profile.bundles')

const dir = path.join(profileDir, 'node_modules', ...PKG.split('/'))
if (!fs.existsSync(dir)) {
  fail(`not present at ${dir}`)
  console.log(problems ? `\nRESULT: ${problems} problem(s)` : '')
  process.exit(1)
}
ok(`resolved on disk -> ${dir}`)

const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const bundleEntry = targetOf(pkg.exports?.['.']) ?? pkg.main
const pluginEntry = targetOf(pkg.exports?.['./plugin'])
const patchEntry = targetOf(pkg.exports?.['./cordis.patch.yml'])

pkg.main ? ok(`main = ${pkg.main}`) : fail('main missing')
bundleEntry ? ok(`exports["."] = ${bundleEntry} (bundle entry)`) : fail('exports["."] missing')
pluginEntry ? ok(`exports["./plugin"] = ${pluginEntry} (host row)`) : fail('exports["./plugin"] missing')

// `dsh.client` and `exports["./client"]` are REQUIRED, not forbidden.
//
// These two checks previously asserted the opposite, describing the browser half as
// "a served page, not a client plugin". That was the design that failed: a page
// injected into document.body cannot respect the collapsed sidebar, cannot use theme
// tokens, and is explicitly discouraged ("choose a slot that already allocates
// space"; "do not write DOM outside your component"). The native entry is a client
// plugin, and its presence is asserted in detail further down.
pkg.dsh?.client
  ? ok('dsh.client declared (the native entry needs a client half)')
  : fail('dsh.client missing — the native sidebar entry cannot load')
pkg.exports?.['./client']
  ? ok('exports["./client"] present')
  : fail('exports["./client"] missing — dsh-client-modules would reject the package')

const patchDecl = pkg.dsh?.bundle?.patch
if (!patchDecl) fail('dsh.bundle.patch missing — the plugin manager refuses the package as a bundle')
else ok(`dsh.bundle.patch declared (${[patchDecl].flat().join(', ')})`)

// The bundle root must be a VALID plugin, i.e. export `apply`. It used to be required
// to be `export {}`; that requirement was wrong and it silently broke the client half,
// because the loader rejects an empty namespace and reports it only as
// `failed to import`. The behavioural half still lives in the `./plugin` row.
if (bundleEntry) {
  const text = fs.readFileSync(path.join(dir, bundleEntry), 'utf8')
  const exportedApply = /export\s+function\s+apply/.test(text)
  exportedApply
    ? ok('bundle entry exports apply — the loader rejects an empty namespace')
    : fail('bundle entry must export apply; an empty module gets no fiber and fails as "failed to import"')
}

if (patchEntry) {
  const patchText = fs.readFileSync(path.join(dir, patchEntry), 'utf8')
  patchText.includes(`${PKG}/plugin`)
    ? ok('patch layer inserts the plugin subpath')
    : fail(`patch layer must insert "${PKG}/plugin"`)
  const isInsertList = /^-\s*insert:/m.test(patchText)
  isInsertList ? ok('patch layer uses the insert list form') : fail('patch layer must be an insert list')
  // TWO rows: the host subpath plus the bare package name for the browser half.
  const rowCount = (patchText.match(/^\s*-\s*id:/gm) ?? []).length
  rowCount === 2
    ? ok('patch layer inserts exactly two rows (host subpath + bare client name)')
    : fail(`patch layer inserts ${rowCount} rows, expected 2`)
}

for (const [label, rel] of [['bundle', bundleEntry], ['plugin', pluginEntry]]) {
  if (!rel) continue
  const abs = path.join(dir, rel)
  fs.existsSync(abs)
    ? ok(`${label} entry exists (${fs.statSync(abs).size} bytes)`)
    : fail(`${label} entry missing`)
}

const pagePath = path.join(dir, 'web', 'market.html')
if (fs.existsSync(pagePath)) {
  const page = fs.readFileSync(pagePath, 'utf8')
  ok(`served page exists (web/market.html, ${page.length} chars)`)
  // The prefix must NOT be under /api: dsh-client-connection claims that prefix
  // for its RPC channel and answers 401 to any request without its browser auth.
  if (page.includes('/api/')) {
    fail('page fetches under /api/ — the connection layer owns that prefix and will answer 401')
  } else {
    ok('page fetches outside /api (connection layer does not intercept)')
  }
  // Service calls (cross-origin) vs local calls (this machine's profile).
  for (const route of ['auth/login', 'auth/me', 'catalog', 'detail', 'admin/users', 'admin/grants']) {
    page.includes(`/dsh-market/${route}`)
      ? ok(`page calls service /dsh-market/${route}`)
      : fail(`page does not call service /dsh-market/${route}`)
  }
  for (const route of ['config', 'install', 'uninstall', 'installed']) {
    page.includes(`/dsh-market/${route}`)
      ? ok(`page calls local /dsh-market/${route}`)
      : fail(`page does not call local /dsh-market/${route}`)
  }
  // The install state belongs on the card, not in a second list.
  page.includes('id="installed"')
    ? fail('page still renders a separate "installed" list — state belongs on the card')
    : ok('no separate installed list; card carries the install state')
  for (const token of ['已安装到本机', 'installedMap']) {
    page.includes(token) ? ok(`card state present: ${token}`) : fail(`card state missing: ${token}`)
  }
} else {
  fail('web/market.html missing — GET /market would serve a fallback notice')
}

// The client must not carry its own account/policy authority any more.
const pluginSource = fs.readFileSync(path.join(dir, 'lib', 'plugin.js'), 'utf8')

// The in-app entry is a CLIENT-HALF registration, so the thing worth asserting is
// the contract that makes a client half load at all. Each rule below was learned by
// breaking it:
//
//   - `dsh.client` must be declared, or `dsh-client-modules` ignores the package;
//   - `exports["./client"]` must exist, or it throws
//     `declares dsh.client but exports no "./client" bundle`;
//   - the artifact must be a plain script registering a factory whose id EQUALS the
//     package name, loaded via `window.__ModuleLoader__.load`;
//   - the bare-package-name row must exist in the patch, because a row naming a
//     subpath is dropped silently by `exactPackageSpecifier`;
//   - `lib/bundle.js` must actually export `apply`. An empty namespace is rejected
//     with `invalid plugin, expect function or object with an "apply" method`, the
//     row gets no fiber, and the ONLY symptom is the audit's `failed to import`.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const pkgName = manifest.name

  const clientDecl = manifest.dsh?.client
  if (clientDecl === undefined) {
    fail('package.json has no dsh.client — the browser half is never loaded')
  } else {
    clientDecl.platform === 'web'
      ? ok('dsh.client.platform is "web"')
      : fail(`dsh.client.platform is ${JSON.stringify(clientDecl.platform)}, expected "web"`)
    Array.isArray(clientDecl.inject)
      ? ok('dsh.client.inject declared', clientDecl.inject.join(', '))
      : fail('dsh.client.inject missing — client-side activation order is undefined')
  }

  const clientRel = manifest.exports?.['./client']
  const clientPath = typeof clientRel === 'string'
    ? clientRel
    : (clientRel !== null && typeof clientRel === 'object' ? clientRel.default : undefined)
  if (typeof clientPath !== 'string') {
    fail('package.json exports no "./client" bundle')
  } else {
    const clientFile = path.join(dir, clientPath)
    if (!fs.existsSync(clientFile)) {
      fail(`exports["./client"] points at a missing file: ${clientPath}`)
    } else {
      const source = fs.readFileSync(clientFile, 'utf8')
      ok(`client bundle present (${clientPath})`)
      source.includes('window.__ModuleLoader__.load')
        ? ok('client bundle uses the documented loader facade')
        : fail('client bundle does not call window.__ModuleLoader__.load')
      source.includes(`id: '${pkgName}'`) || source.includes(`id: "${pkgName}"`)
        ? ok('client factory id equals the package name')
        : fail(`client factory id must equal "${pkgName}" exactly, or the row fails`)
      // Plain script, not a module: no import/export statements at top level.
      // Written as an if, not a bare regex as a ternary condition — a leading `/`
      // there parses as division.
      const isModule = /^\s*(import|export)\s/m.test(source)
      if (isModule) {
        fail('client bundle contains import/export — it must be a classic script')
      } else {
        ok('client bundle is a classic script (no import/export)')
      }
      // Only theme tokens for colour, per references/practices.md.
      const literalColour = /(?:color|background|borderColor)\s*:\s*['"](?:#|rgb|hsl)/i.test(source)
      if (literalColour) {
        fail('client bundle uses a literal colour in a style — use --dsw-alias-* tokens')
      } else {
        ok('client bundle styles use theme tokens only')
      }

      // The bare-name row must exist, and the bundle root must be a real plugin.
      const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
      const bareRow = new RegExp(
        `^\\s+name:\\s*['"]?${pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`,
        'm',
      ).test(patch)
      if (bareRow) {
        ok('cordis.patch.yml has the bare-package-name client row')
      } else {
        fail('cordis.patch.yml has no bare-package-name row — the client half never loads')
      }

      const bundleSource = fs.readFileSync(path.join(dir, 'lib', 'bundle.js'), 'utf8')
      if (/export\s+function\s+apply/.test(bundleSource)) {
        ok('lib/bundle.js exports apply (loader rejects an empty namespace)')
      } else {
        fail('lib/bundle.js must export apply — an empty module fails the row with "failed to import"')
      }
    }
  }
}

for (const stale of ['market-store.js', 'market-policy.js']) {
  pluginSource.includes(stale)
    ? fail(`lib/plugin.js still imports ${stale} — authority belongs to the service`)
    : ok(`lib/plugin.js does not import ${stale}`)
}
pluginSource.includes('MARKET_SERVICE_URL')
  ? ok('lib/plugin.js reads MARKET_SERVICE_URL')
  : fail('lib/plugin.js does not read MARKET_SERVICE_URL')
pluginSource.includes("from './tar.js'")
  ? ok('lib/plugin.js extracts archives via lib/tar.js')
  : fail('lib/plugin.js does not use lib/tar.js')

for (const file of ['server/index.mjs', 'server/cli.mjs', 'server/lib/policy.js', 'server/lib/store.js']) {
  fs.existsSync(path.join(dir, file)) ? ok(`service present: ${file}`) : fail(`service missing: ${file}`)
}

resolveSpec(PKG)
resolveSpec(`${PKG}/plugin`)

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
